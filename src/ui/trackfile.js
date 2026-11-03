// trackfile.js: read any track file given to the app (GPX, FIT, TCX, or one inside a .zip/.gz export) as GPX text.
import { isFit, fitToGpx, tcxToGpx } from "../core/fit.js";

// What the "Add GPX" buttons accept.
export const TRACK_ACCEPT = ".gpx,.fit,.tcx,.zip,.gz,application/gpx+xml,text/xml,application/zip,application/gzip,application/octet-stream";

const tfName = (n) => String(n || "").replace(/^.*[\\/]/, "").replace(/\.(gz|zip)$/i, "").replace(/\.(gpx|fit|tcx)$/i, "");

// Decompress bytes with the browser's own DecompressionStream ("gzip" or "deflate-raw").
async function tfInflate(bytes, kind) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream(kind))).arrayBuffer());
}

// The first .gpx/.fit/.tcx inside a zip (Garmin Connect "Export original"), read from the zip's central directory.
async function tfUnzip(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("This zip file is damaged.");
  let p = dv.getUint32(eocd + 16, true);
  for (let n = dv.getUint16(eocd + 10, true); n > 0 && dv.getUint32(p, true) === 0x02014b50; n--) {
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nl));
    const local = dv.getUint32(p + 42, true);
    p += 46 + nl + xl + cl;
    if (!/\.(gpx|fit|tcx)$/i.test(name)) continue;
    const at = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = b.subarray(at, at + size);
    return { name, bytes: method === 0 ? data : await tfInflate(data, "deflate-raw") };
  }
  throw new Error("No GPX, FIT or TCX file in this zip.");
}

/** File -> { xml, label }: GPX text whatever the format given. Throws a readable error. */
export async function readTrackFile(file) {
  let bytes = new Uint8Array(await file.arrayBuffer());
  let name = file.name || "";
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) { bytes = await tfInflate(bytes, "gzip"); name = name.replace(/\.gz$/i, ""); }
  else if (bytes[0] === 0x50 && bytes[1] === 0x4b) ({ name, bytes } = await tfUnzip(bytes));
  const label = tfName(name) || tfName(file.name) || "Run";
  if (isFit(bytes)) return { xml: fitToGpx(bytes, label), label };
  const text = new TextDecoder().decode(bytes);
  if (text.includes("<TrainingCenterDatabase")) return { xml: tcxToGpx(text, label), label };
  return { xml: text, label };
}

/** Same, but never throws: a bad file gives empty text, so the drop box shows its usual "not a GPX" message. */
export async function readTrackSafe(file) {
  try { return await readTrackFile(file); } catch (e) { return { xml: `<!--err ${e.message}-->`, label: tfName(file.name) }; }
}

/** "From Garmin or Strava?": how to get the file, under the run drop boxes. */
export function exportHowHtml() {
  return `<details class="how-export"><summary>From Garmin or Strava?</summary><ul>
    <li>Garmin Connect website: open the run, gear menu, Export Original (a .zip, give it as it is) or Export to GPX.</li>
    <li>Strava website: open the run, ... menu, Export GPX or Export Original.</li>
    <li>File already on your phone: share it to Prep my race (installed app) or tap Add GPX.</li>
  </ul><small>GPX, FIT, TCX and .zip files work. Heart rate is never read.</small></details>`;
}

/** Files shared to the installed app (Android share menu, kept by sw.js) or opened with it (desktop): fn(File) for each. */
export async function initSharedFiles(fn) {
  if (window.launchQueue) window.launchQueue.setConsumer(async (p) => { for (const h of p.files || []) fn(await h.getFile()); });
  const q = new URLSearchParams(location.search);
  if (!q.has("shared") || !window.caches) return;
  q.delete("shared");
  history.replaceState(null, "", location.pathname + (q.toString() ? `?${q}` : "") + location.hash);
  try {
    const c = await caches.open("pmr-share");
    const r = await c.match("shared-track");
    if (!r) return;
    await c.delete("shared-track");
    fn(new File([await r.blob()], decodeURIComponent(r.headers.get("x-name") || "shared.gpx")));
  } catch (e) { /* nothing shared */ }
}
