#!/usr/bin/env node
/**
 * Single entry point for the packaged launcher.
 *
 * Exists so the executable has exactly one entry: once bundled, every module reports the
 * executable's own path, so any module that decides "am I the entry point?" by comparing
 * paths would fire. Nothing is imported here for side effects.
 */
import { main } from './launch.mjs';

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`[bridge] ${error.message}`);
  process.exitCode = 1;
}
