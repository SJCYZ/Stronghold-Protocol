import fs from 'node:fs/promises';
import path from 'node:path';
import { createResourceIndex } from '../server/resources.js';
import { rewriteAssetPaths } from '../shared/cdn.js';

const [dataDir, publicDir, assetsCdn = ''] = process.argv.slice(2);
if (!dataDir || !publicDir) throw new Error('usage: prepare-r2-data.mjs <staged-data-dir> <public-dir> [assets-cdn]');
const assetsBase = assetsCdn.replace(/\/+$/, '');
const resourceIndex = await createResourceIndex({
  dataDir,
  publicDir,
  cdnBase: assetsBase,
  rewrite: (value) => assetsBase ? rewriteAssetPaths(value, assetsBase) : value,
}).get();
await fs.writeFile(path.join(dataDir, 'resource-manifest.json'), `${JSON.stringify(resourceIndex.manifest)}\n`);
await fs.rm(path.join(dataDir, 'resource-packs.json'), { force: true });

console.log(`Prepared ${resourceIndex.manifest.count} resources for ${resourceIndex.manifest.version}.`);
