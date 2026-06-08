// projectContext.js — Anti-hallucination. Injects real project state into requests.
// Async scan + pre-warm on import so first request hits hot cache (zero latency).

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { logDebug } from "../logger/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(__dirname, "../../..");

// Exclusions for scan (match .rules §4 description)
const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  "session",
  "logs",
  "uploads",
]);
const WHITELIST = new Set([".agent-brief.md", ".rules"]);

let _cache = "";
const TTL_MS = 60_000; // 60s — project rarely changes structure
let _lastScan = 0;

/**
 * Async recursive scan. Non-blocking — yields to event loop between dirs.
 */
async function scan(dir, prefix = "", depth = 3) {
  if (depth > 4) return "";
  let out = "";
  try {
    const entries = await fs.readdir(dir);
    const items = [];

    for (const entry of entries) {
      const full = path.join(dir, entry);
      // Fast batch stat via try — skip symlinks/broken links silently
      let stats;
      try {
        stats = await fs.lstat(full);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        if (!EXCLUDE_DIRS.has(entry)) items.push({ n: `${entry}/`, d: true });
      } else if (!entry.startsWith(".") || WHITELIST.has(entry)) {
        items.push({ n: entry, d: false });
      }
    }

    // Files first, then dirs — compact format: no tree chars to save tokens
    const files = items.filter((i) => !i.d).map((i) => i.n);
    const dirs = items.filter((i) => i.d).map((i) => i.n.replace(/\/$/, ""));

    for (const name of files) {
      out += prefix + "- " + name + "\n";
    }
    for (let j = 0; j < dirs.length; j++) {
      const d = dirs[j];
      out += prefix + "+ " + d + "/\n";
      out += await scan(path.join(dir, d), prefix + "  ", depth + 1);
    }
  } catch (e) {
    logDebug(`projectContext: ${dir} error: ${e.message}`);
  }
  return out;
}

/**
 * Build compact context block. ~30 tokens instead of ~300.
 */
export async function getProjectStructureAsync() {
  const now = Date.now();
  if (_cache && now - _lastScan < TTL_MS) return _cachedBuild();

  // Non-blocking scan — await allows other requests to proceed
  const tree = await scan(PROJECT_ROOT);
  const count = (tree.match(/- |\/\n/g) || []).length;
  _cache = `---PROJ(${count})---\n${tree}---/---`;
  _lastScan = now;

  return _cachedBuild();
}

/**
 * Synchronous cached version for routes.js (always hits cache after preload).
 */
function _cachedBuild() {
  if (!_cache) throw new Error("projectContext: not preloaded yet");
  return _injectRules(_cache);
}

function _injectRules(headless) {
  // Ultra-compact anti-hallucination. Every token costs Qwen inference time.
  return `NO HALLUCINATE. Use tree below only. Not in tree = does not exist.\n${headless}\n/test.py IMAGE_GUIDE.md docs/ DELETED`;
}

/**
 * Pre-warm cache on module import so first request has zero wait.
 */
scan(PROJECT_ROOT)
  .then((tree) => {
    const count = (tree.match(/- |\/\n/g) || []).length;
    _cache = `---PROJ(${count})---\n${tree}---/---`;
    _lastScan = Date.now();
  })
  .catch(() => {});

/** Sync export for routes.js (calls synchronously). Returns cache or empty string on cold-start. */
export function buildProjectContext() {
  if (!_cache) return ""; // Safety: module not preloaded yet — skip injection
  return _cachedBuild();
}
