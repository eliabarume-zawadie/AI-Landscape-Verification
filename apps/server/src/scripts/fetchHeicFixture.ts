// Downloads a real HEVC-encoded HEIC sample for the HEIC decode tests.
// It is NOT committed (third-party image; licence unclear). Prefer replacing it with a
// real crew photo that you are allowed to keep in the repo.
//   npx tsx apps/server/src/scripts/fetchHeicFixture.ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { REPO_ROOT } from "../test/helpers";

const URL = "https://nokiatech.github.io/heif/content/images/autumn_1440x960.heic";
const target = path.join(REPO_ROOT, "fixtures", "heic", "sample.heic");
const res = await fetch(URL);
if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, Buffer.from(await res.arrayBuffer()));
console.log(`Saved ${target}`);
