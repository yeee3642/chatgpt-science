import { createRequire } from 'node:module';
import path from 'node:path';

const MiB = 1024 * 1024;
export const PDF_LIMITS = Object.freeze({
  inputBytes: 32 * MiB,
  pages: 50,
  expandedBodyBytes: 32 * MiB,
  imageBase64Bytes: 12 * MiB,
  renderWidth: 1600,
  renderPixels: 16_000_000,
});

export class PdfDocumentError extends Error {
  constructor(message, statusCode = 422, options) {
    super(message, options);
    this.name = 'PdfDocumentError';
    this.statusCode = statusCode;
  }
}

const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const isPdf = (block) => block?.type === 'document'
  && String(block.source?.media_type || '').toLowerCase() === 'application/pdf';

function decodePdf(source) {
  if (source.type !== 'base64' || typeof source.data !== 'string') {
    throw new PdfDocumentError('PDF input requires a base64 source. Remote PDF URLs are not fetched.', 400);
  }
  // Check length before decoding so malformed or oversized requests cannot make
  // Buffer.from allocate arbitrarily large binary data.
  const maximumEncodedLength = 4 * Math.ceil(PDF_LIMITS.inputBytes / 3);
  if (source.data.length > maximumEncodedLength) {
    throw new PdfDocumentError('PDF exceeds the 32 MiB decoded input limit. Split the document.', 413);
  }
  const encoded = source.data;
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new PdfDocumentError('PDF source contains invalid standard base64 data.', 400);
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > PDF_LIMITS.inputBytes) {
    throw new PdfDocumentError('PDF exceeds the 32 MiB decoded input limit. Split the document.', 413);
  }
  if (bytes.toString('base64') !== encoded) {
    throw new PdfDocumentError('PDF source contains noncanonical base64 padding.', 400);
  }
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    throw new PdfDocumentError('The supplied application/pdf document has no PDF header.', 400);
  }
  return bytes;
}

// Only visit actual content containers. A document-shaped object inside a tool
// schema or tool_use.input must remain data for that tool, not be rewritten.
function visitContent(content, visitor) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (isPdf(block)) visitor(block);
    else if (block?.type === 'tool_result') visitContent(block.content, visitor);
    else if (block?.type === 'document' && block.source?.type === 'content') {
      visitContent(block.source.content, visitor);
    }
  }
}

function allContent(body, visitor) {
  visitContent(body.system, visitor);
  for (const message of body.messages || []) visitContent(message?.content, visitor);
}

async function loadParser(bytes) {
  let PDFParse;
  let pdfRoot;
  try {
    ({ PDFParse } = await import('pdf-parse'));
    const require = createRequire(import.meta.url);
    pdfRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
  } catch (cause) {
    throw new PdfDocumentError('Local PDF support is unavailable. Install pdf-parse@2.4.5 and its runtime dependencies in the bridge folder.', 503, { cause });
  }
  const resourceDirectory = (name) => path.join(pdfRoot, name).replaceAll('\\', '/') + '/';
  return new PDFParse({
    data: bytes,
    // All fonts, CMaps and decoders come from the local pinned npm dependency.
    // The helper does not contact an OCR service or fetch document links.
    cMapUrl: resourceDirectory('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: resourceDirectory('standard_fonts'),
    wasmUrl: resourceDirectory('wasm'),
    useWorkerFetch: false,
    isEvalSupported: false,
    stopAtErrors: true,
    useSystemFonts: false,
    verbosity: 0,
  });
}

async function expandOne(block, budget, ordinal) {
  const bytes = decodePdf(block.source);
  const parser = await loadParser(bytes);
  const label = typeof block.title === 'string' && block.title.trim() ? block.title : `PDF document ${ordinal}`;
  try {
    const basicInfo = await parser.getInfo();
    if (!Number.isInteger(basicInfo.total) || basicInfo.total < 1) {
      throw new PdfDocumentError(`PDF "${label}" contains no readable pages.`);
    }
    if (basicInfo.total > PDF_LIMITS.pages) {
      throw new PdfDocumentError(`PDF "${label}" has ${basicInfo.total} pages; the limit is 50. Split it into smaller documents. No pages were omitted.`, 413);
    }
    const total = basicInfo.total;
    const pageInfo = await parser.getInfo({ parsePageInfo: true });
    const textPages = [];
    const visualBlocks = [];
    for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
      const geometry = pageInfo.pages.find((page) => page.pageNumber === pageNumber);
      const width = geometry?.width;
      const height = geometry?.height;
      const pixels = PDF_LIMITS.renderWidth ** 2 * height / width;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0
          || !Number.isFinite(pixels) || pixels > PDF_LIMITS.renderPixels) {
        throw new PdfDocumentError(`PDF "${label}", page ${pageNumber}, exceeds the safe page rendering dimensions. Split or resize that page; its visual content was not discarded.`, 413);
      }
      const textResult = await parser.getText({ partial: [pageNumber], pageJoiner: '' });
      const pageText = textResult.pages.find((page) => page.num === pageNumber)?.text;
      if (typeof pageText !== 'string') {
        throw new PdfDocumentError(`PDF "${label}" did not return text information for page ${pageNumber}.`);
      }
      const markedText = `[PDF page ${pageNumber} of ${total}]\n${pageText.trim()
        ? pageText : '[No extractable text on this page. Read the attached page image; OCR text has not been fabricated.]'}`;
      textPages.push(markedText);
      budget.add(Buffer.byteLength(markedText, 'utf8') + 4);

      // Screenshot every page: vector plots and formulas are not necessarily
      // embedded image objects, and text extraction alone loses their meaning.
      const screenshot = await parser.getScreenshot({
        partial: [pageNumber], desiredWidth: PDF_LIMITS.renderWidth,
        imageDataUrl: false, imageBuffer: true,
      });
      const page = screenshot.pages.find((item) => item.pageNumber === pageNumber);
      if (!page?.data?.byteLength) {
        throw new PdfDocumentError(`PDF "${label}" could not render page ${pageNumber}. No text-only fallback was sent.`);
      }
      const png = Buffer.from(page.data);
      if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
        throw new PdfDocumentError(`PDF "${label}" returned an invalid PNG for page ${pageNumber}.`);
      }
      const data = png.toString('base64');
      if (data.length > PDF_LIMITS.imageBase64Bytes) {
        throw new PdfDocumentError(`PDF "${label}", page ${pageNumber}, exceeds the 12 MiB encoded page-image limit. Split or simplify that page.`, 413);
      }
      const marker = { type: 'text', text: `[PDF visual: ${label}; page ${pageNumber} of ${total}; complete page rendered at ${page.width} x ${page.height} pixels]` };
      const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data } };
      budget.add(jsonBytes(marker) + jsonBytes(image) + 2);
      visualBlocks.push(marker, image);
    }
    const textDocument = {
      ...block,
      source: {
        type: 'text', media_type: 'text/plain',
        data: `[PDF document: ${label}]\n${total} pages. Extracted text follows; a complete visual image of every page is also attached.\n\n${textPages.join('\n\n')}`,
      },
    };
    // Text was budgeted page by page above. Account for its document wrapper and
    // JSON escaping exactly now, preserving title/context/citation configuration.
    const rawTextBytes = textPages.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8') + 4, 0);
    budget.add(jsonBytes(textDocument) + 1 - rawTextBytes);
    return [textDocument, ...visualBlocks];
  } catch (error) {
    if (error instanceof PdfDocumentError) throw error;
    if (error?.name === 'PasswordException') {
      throw new PdfDocumentError(`PDF "${label}" is password protected. Upload an unlocked copy.`, 422, { cause: error });
    }
    throw new PdfDocumentError(`PDF "${label}" could not be completely read and rendered: ${error?.message || String(error)}`, 422, { cause: error });
  } finally {
    await parser.destroy().catch(() => {});
  }
}

/**
 * Expand inline Anthropic PDF documents into their complete extracted text plus
 * every rendered page. Returns a deep clone; input bodies are never mutated.
 * All limits are explicit failures, never silent text/page/figure truncation.
 */
export async function expandPdfDocuments(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new PdfDocumentError('The request body must be an object.', 400);
  }
  let clone;
  try { clone = structuredClone(body); }
  catch (cause) { throw new PdfDocumentError('The request body must contain cloneable JSON data.', 400, { cause }); }
  if (clone.messages !== undefined && !Array.isArray(clone.messages)) {
    throw new PdfDocumentError('messages must be an array.', 400);
  }
  const documents = [];
  allContent(clone, (block) => documents.push(block));
  if (documents.length === 0) return clone;
  const budget = {
    used: jsonBytes(clone) - documents.reduce((sum, block) => sum + jsonBytes(block), 0),
    add(bytes) {
      this.used += bytes;
      if (this.used > PDF_LIMITS.expandedBodyBytes) {
        throw new PdfDocumentError('PDF expansion plus conversation exceeds the 32 MiB bridge request limit. Split the PDF or reduce conversation attachments. No pages or figures were omitted.', 413);
      }
    },
  };
  const replacements = new Map();
  for (let index = 0; index < documents.length; index += 1) {
    const block = documents[index];
    replacements.set(block, await expandOne(block, budget, index + 1));
  }
  function replace(content) {
    if (!Array.isArray(content)) return content;
    return content.flatMap((block) => {
      if (replacements.has(block)) return replacements.get(block);
      if (block?.type === 'tool_result') block.content = replace(block.content);
      else if (block?.type === 'document' && block.source?.type === 'content') {
        block.source.content = replace(block.source.content);
      }
      return [block];
    });
  }
  if (Array.isArray(clone.system)) clone.system = replace(clone.system);
  for (const message of clone.messages || []) {
    if (message && typeof message === 'object') message.content = replace(message.content);
  }
  if (jsonBytes(clone) > PDF_LIMITS.expandedBodyBytes) {
    throw new PdfDocumentError('Expanded PDF request exceeds 32 MiB. Split the document; no truncated result was sent.', 413);
  }
  return clone;
}
