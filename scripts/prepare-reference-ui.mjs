import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { brotliCompressSync, constants } from 'node:zlib';
import { parse } from '@babel/parser';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultSource = path.resolve(projectRoot, '../ChatGPTScience/data/runtime/0.1.50-release/web-dist');
const destination = path.join(projectRoot, 'reference-ui');
const PINNED = {
  'index.html': '5ec7875d55e81d1e8dc12e11554d99c9c73e25851bbd5d5a5e1452e34c28e91d',
  'assets/index-ConA6-ks.js': '9c65c84f48fe6fea1a84fe768d3c719370ceac45e804a85d7c69cd3f4827922f',
  'assets/ControlPanelModal-CrguLQqr.js': '05d77e6724d6d2b487e2083f470398583d67fcd19a439fe1999f98429da765f5',
  'assets/ProjectSettings-DDVJE5XK.js': 'd3215956665a52500b2dd6509b086937fce589a8a99cdddc53b929dfa85de705',
};
const hash = data => createHash('sha256').update(data).digest('hex');
const staticExtensions = new Set(['.html', '.js', '.mjs', '.css', '.br', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.json', '.webmanifest', '.wasm', '.map', '.txt', '.pdb']);

function replaceOnce(source, before, after, label) {
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + before.length) >= 0) throw new Error(`Expected one exact ${label} binding.`);
  return source.slice(0, at) + after + source.slice(at + before.length);
}

function functionEdits(source, replacements) {
  const ast = parse(source, { sourceType: 'module', attachComment: false });
  const edits = Object.entries(replacements).map(([name, replacement]) => {
    const matches = ast.program.body.filter(node => node.type === 'FunctionDeclaration' && node.id?.name === name);
    if (matches.length !== 1) throw new Error(`Expected one top-level ${name} function declaration.`);
    return { start: matches[0].start, end: matches[0].end, replacement };
  }).sort((left, right) => right.start - left.start);
  let text = source;
  for (const edit of edits) text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
  const bindings = tree => new Set(tree.program.body.flatMap(node => node.type === 'VariableDeclaration' ? node.declarations.map(item => item.id?.name).filter(Boolean) : ['FunctionDeclaration', 'ClassDeclaration'].includes(node.type) ? [node.id?.name].filter(Boolean) : []));
  const after = bindings(parse(text, { sourceType: 'module', attachComment: false }));
  for (const name of bindings(ast)) if (!after.has(name)) throw new Error(`Provider patch removed an unrelated declaration: ${name}`);
  return text;
}

const loginContent = `function cgProviderContent({redirect:e="/"}){const t=globalThis.__CHATGPT_PROVIDER__,[n,r]=f.useState(()=>t.snapshot());f.useEffect(()=>t.subscribe(r),[t]);const s=n.phase==="starting"||n.phase==="waiting",o=()=>t.login({redirect:e}).catch(()=>{}),i=()=>t.check({redirect:e}).catch(()=>{});return a.jsxs("div",{className:"flex w-full flex-col gap-md",children:[n.phase==="error"?a.jsx(bo,{variant:"danger",role:"alert",className:"w-full","data-testid":"sign-in-error",children:a.jsx("p",{children:n.message})}):a.jsx("p",{className:"text-footnote text-secondary",role:"status",children:n.message||"Sign in with your ChatGPT account to use this independent workbench."}),a.jsxs("div",{className:"flex w-full flex-col gap-sm",children:[a.jsx(Et,{variant:"primary",size:"lg",className:"w-full",busy:s,disabled:s,onClick:o,children:s?"Waiting for ChatGPT sign-in…":"Sign in with ChatGPT"}),n.authUrl&&a.jsx(Et,{variant:"secondary",size:"lg",className:"w-full",href:n.authUrl,target:"_blank",rel:"noopener noreferrer",children:"Open OpenAI sign-in"}),a.jsx(Et,{variant:"secondary",size:"lg",className:"w-full",onClick:i,children:"Check sign-in status"}),s&&a.jsx(Et,{variant:"ghost",size:"sm",className:"w-full",onClick:()=>t.cancel().catch(()=>{}),children:"Cancel sign-in"})]})]})}`;
const loginPage = `${loginContent}function gYt(){const e=new URLSearchParams(window.location.search),t=e.get("redirect")||"/";f.useEffect(()=>{globalThis.__CHATGPT_PROVIDER__.check({redirect:t}).catch(()=>{})},[t]);return a.jsx(XS,{children:a.jsx(cgProviderContent,{redirect:t})})}`;
const loginModal = 'function SKe(){const e=oB();return a.jsx(ts.Root,{open:e,onOpenChange:t=>{t||eg.set(!1)},children:a.jsxs(ts.Popup,{size:"sm","data-testid":"proxy-login-modal",children:[a.jsx(ts.Header,{children:"Sign in to ChatGPT Science"}),a.jsx(cgProviderContent,{redirect:"/"})]})})}';

export function patchMainBundle(source) {
  let text = functionEdits(source, { gYt: loginPage, SKe: loginModal });
  text = replaceOnce(text, '"system.logout":()=>Lt("/auth/logout")', '"system.logout":()=>globalThis.__CHATGPT_PROVIDER__.disconnect()', 'app-local ChatGPT disconnect');
  text = replaceOnce(text, 'const Sn="Claude Science",lKe="claude-science"', 'const Sn="ChatGPT Science",lKe="claude-science"', 'product display name');
  text = replaceOnce(text, 'e=>e.email?{user_id:e.user_id,email:e.email,provider:e.provider??null', 'e=>e.user_id?{user_id:e.user_id,email:e.email??null,provider:e.provider??null', 'current-user identity');
  text = replaceOnce(text, '"auth.loginPaste":e=>mt(`/auth/login${Ps({provider:e.provider,redirect:e.redirect,organization_uuid:e.organization_uuid,mode:"paste"})}`)', '"auth.loginPaste":e=>globalThis.__CHATGPT_PROVIDER__.login({redirect:e.redirect})', 'legacy local sign-in action');
  text = replaceOnce(text, '"auth.exchange":e=>Lt("/auth/exchange",e)', '"auth.exchange":()=>globalThis.__CHATGPT_PROVIDER__.exchange()', 'removed vendor code-exchange action');
  text = replaceOnce(text, 'const mYt=[{id:"claude_ai",label:"Sign in on the web"}]', 'const mYt=[{id:"chatgpt",label:"Sign in with ChatGPT"}]', 'provider choice');
  text = replaceOnce(text, 'a.jsx(iUe,{product:Sn.replace(/^Claude /,""),state:Rxe,height:28,role:"heading","aria-level":1,className:"items-center"})', 'a.jsx("div",{role:"heading","aria-level":1,className:"items-center",style:{height:28,fontSize:24,lineHeight:"28px"},children:Sn})', 'login product wordmark');
  return text;
}

async function inventory(root, directory = root) {
  const files = [];
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Symlink directories are not copied.');
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.branding-backup' || entry.name.startsWith('.')) continue;
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink asset refused: ${entry.name}`);
    if (entry.isDirectory()) files.push(...await inventory(root, file));
    else if (entry.isFile()) {
      if (!staticExtensions.has(path.extname(entry.name).toLowerCase())) throw new Error(`Non-static file refused: ${entry.name}`);
      files.push(path.relative(root, file).replaceAll(path.sep, '/'));
    }
  }
  if (files.length > 2000) throw new Error('Unexpected static asset inventory size.');
  return files.sort();
}

export async function prepareReferenceUi(source = defaultSource) {
  source = path.resolve(source);
  if (path.basename(source) !== 'web-dist' || source.split(path.sep).some(part => part.toLowerCase() === '.claude-science')) throw new Error('Use only the copied static web-dist, never the original application data directory.');
  const files = await inventory(source);
  for (const [relative, expected] of Object.entries(PINNED)) if (hash(await fs.readFile(path.join(source, relative))) !== expected) throw new Error(`Source hash changed; provider patch must be reviewed: ${relative}`);
  const helper = await fs.readFile(path.join(projectRoot, 'reference-adapter/provider-login.js'));
  const preparerSha256 = hash(await fs.readFile(fileURLToPath(import.meta.url)));
  const existingManifest = await fs.readFile(path.join(destination, 'reference-manifest.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existingManifest) {
    if (existingManifest.version !== 1 || !Array.isArray(existingManifest.assets)) throw new Error('Unrecognized existing static preparation.');
    for (const asset of existingManifest.assets) {
      if (path.isAbsolute(asset.path) || asset.path.split(/[\\/]/).some(part => part === '..')) throw new Error('Unsafe path in static preparation manifest.');
      if (hash(await fs.readFile(path.join(destination, asset.path))) !== asset.sha256) throw new Error(`Prepared asset was modified independently: ${asset.path}`);
    }
  }
  if (existingManifest?.helperSha256 === hash(helper) && existingManifest.preparerSha256 === preparerSha256) {
    return { prepared: true, unchanged: true, destination, files: existingManifest.assets.length };
  }
  if (!existingManifest) try { const existing = await fs.readdir(destination); if (existing.length) throw new Error('reference-ui already exists without our manifest; do not overwrite it implicitly.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const staging = `${destination}.stage-${randomUUID()}`;
  await fs.mkdir(staging);
  try {
    for (const relative of files) { const target = path.join(staging, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(path.join(source, relative), target); }
    const edits = [];
    async function change(relative, transform) {
      const target = path.join(staging, relative), original = await fs.readFile(target), after = Buffer.from(transform(original.toString('utf8')));
      await fs.writeFile(target, after);
      edits.push({ path: relative, beforeSha256: hash(original), afterSha256: hash(after) });
      if (files.includes(`${relative}.br`)) await fs.writeFile(`${target}.br`, brotliCompressSync(after, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }));
    }
    await change('assets/index-ConA6-ks.js', patchMainBundle);
    const accountLabels = text => text.replaceAll('"Sign out"', '"Disconnect ChatGPT"').replaceAll('"Sign out?"', '"Disconnect ChatGPT?"').replaceAll('"Any running sessions will stop."', '"Research in this app will stop. Your other ChatGPT and Codex sessions stay signed in."').replaceAll('"Sign in with Claude"', '"Sign in with ChatGPT"');
    await change('assets/ControlPanelModal-CrguLQqr.js', text => accountLabels(replaceOnce(replaceOnce(text, 'li={claude_ai:"https://claude.ai/settings"}', 'li={chatgpt:"https://chatgpt.com/#settings"}', 'account settings URL'), 'Zs=li.claude_ai', 'Zs=li.chatgpt', 'account settings provider')));
    await change('assets/ProjectSettings-DDVJE5XK.js', text => {
      for (const phrase of [
        'Instructions for Claude',
        'Claude reads these in every session in this project. Use them for background, conventions, and rules. You can edit them later.',
        'Claude reads these in every session in this project. Use them for background, conventions, and rules.',
        'This helps you tell your projects apart. It isn’t part of the instructions to Claude.',
      ]) text = replaceOnce(text, JSON.stringify(phrase), JSON.stringify(phrase.replaceAll('Claude', 'ChatGPT')), 'visible project instruction label');
      return accountLabels(text);
    });
    await change('index.html', text => replaceOnce(replaceOnce(text, '<title>Claude Science</title>', '<title>ChatGPT Science</title>', 'HTML title'), '<script type="module" crossorigin src="./assets/index-ConA6-ks.js"></script>', '<script src="./provider-login.js"></script>\n    <script type="module" crossorigin src="./assets/index-ConA6-ks.js"></script>', 'provider helper load order'));
    if (files.includes('manifest.webmanifest')) await change('manifest.webmanifest', text => text.replace('"name": "Claude Science"', '"name": "ChatGPT Science"'));
    await fs.writeFile(path.join(staging, 'provider-login.js'), helper);
    const assets = [];
    for (const relative of [...files, 'provider-login.js']) assets.push({ path: relative, sha256: hash(await fs.readFile(path.join(staging, relative))) });
    const manifest = { version: 1, createdAt: new Date().toISOString(), sourceVersion: '0.1.50-release', sourceHashes: PINNED, helperSha256: hash(helper), preparerSha256, edits, assets, authentication: 'genuine ChatGPT via local Codex account bridge', engineCopied: false };
    await fs.writeFile(path.join(staging, 'reference-manifest.json'), JSON.stringify(manifest, null, 2));
    if (existingManifest) {
      const backups = path.join(projectRoot, 'reference-adapter', 'backups');
      await fs.mkdir(backups, { recursive: true });
      const previous = path.join(backups, `reference-ui-${randomUUID()}`);
      await fs.rename(destination, previous);
      try { await fs.rename(staging, destination); } catch (error) { await fs.rename(previous, destination); throw error; }
    } else {
      await fs.rmdir(destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fs.rename(staging, destination);
    }
    return { prepared: true, destination, files: assets.length, edits };
  } catch (error) {
    // Staging remains under this project for inspection; no original or existing destination is removed.
    throw new Error(`${error.message} (staging: ${staging})`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await prepareReferenceUi(process.argv[2]), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
