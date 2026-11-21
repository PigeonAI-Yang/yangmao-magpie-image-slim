import { fileURLToPath } from "node:url"
import { _internal } from "./image-slim.middleware.js"

const { collect, currentImages, matches, options, placeholder, requestBytes, turnStart, matchesAudio, audioToOmit, audioPlaceholder } = _internal
const worker = fileURLToPath(new URL("./image-preview.py", import.meta.url))
const MAX_PREVIEW_BYTES = 128_000
const FORWARDING_MARGIN = 256_000
const DISPATCH_HOOK_BUDGET = 30_000_000
const THREAD_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const CHECKSUM = /^[a-f0-9]{64}$/

function restoreCommand(ctx, archive, digest) {
  const root = ctx.options.codex_history_path
  if (!archive || !root || !THREAD_ID.test(ctx.session) || (digest !== "IMAGE_SHA256" && !CHECKSUM.test(digest))) return ""
  const quote = (arg) => "'" + arg.replaceAll("'", "''") + "'"
  return "& " + [ctx.options.python_path ?? "python", "-I", worker, "--restore",
    archive, root, ctx.session, digest].map(quote).join(" ")
}

function mentionsArchive(value, archive) {
  if (typeof value === "string") {
    if (!value.startsWith("data:") && value.includes(archive.split(/[/\\]/).at(-1))) {
      const normalized = value.replace(/\\+/g, "/")
      return normalized.includes(archive.replace(/\\+/g, "/") + "/")
    }
    return false
  }
  return value && typeof value === "object" && Object.values(value).some((part) => mentionsArchive(part, archive))
}

async function prepareImages(images, archive, ctx) {
  if (!images.length) return []
  const encoderInput = new Blob(images.flatMap(({ image, preview }) => [
    preview ? "1 " : "0 ", image.dataUrl, "\n",
  ]))
  const process = Bun.spawn([ctx.options.python_path ?? "python", "-I", worker, archive], {
    stdin: encoderInput,
    stdout: "pipe",
    stderr: "ignore",
    signal: ctx.signal,
    windowsHide: true,
  })
  const [output, exitCode] = await Promise.all([new Response(process.stdout).json(), process.exited])
  if (exitCode || !Array.isArray(output) || output.length !== images.length) {
    throw new Error("Image preview encoder returned an incomplete result")
  }
  return output
}

export async function onRequest(body, ctx) {
  const policy = options(ctx.options)
  if (ctx.protocol !== "responses") return
  const imageRoute = policy.request_budget_bytes && matches(ctx, policy)
  if (!imageRoute && !matchesAudio(ctx, policy)) return
  const archive = ["local", "magpie-key"].includes(ctx.origin) ? ctx.options.archive_path ?? "" : ""
  const legacyRestore = restoreCommand(ctx, archive, "IMAGE_SHA256")
  const hasLegacyPath = legacyRestore && mentionsArchive(body.input, archive)
  if (hasLegacyPath) {
    const instruction = `To open previous Magpie cached media, try the cached file first. If it is missing, run this local PowerShell command with IMAGE_SHA256 replaced by the 64 hexadecimal characters in the cached filename, without its extension: ${legacyRestore} . Open images with view_image. For audio, use any existing transcript or an authorized transcription tool that returns text.`
    if (typeof body.instructions === "string") body.instructions += "\n\n" + instruction
    else if (Array.isArray(body.input)) body.input.unshift({ type: "message", role: "developer", content: [{ type: "input_text", text: instruction }] })
  }
  const found = collect(body, ctx.protocol)
  const audio = audioToOmit(found, ctx, policy)
  if (!found || (!found.images.length && !audio.length)) return hasLegacyPath ? body : undefined
  const before = requestBytes(body, [...found.images, ...found.audio])
  const audioJobs = archive ? audio.filter((clip) => clip.dataUrl) : []
  let audioReferences = []
  try {
    audioReferences = await prepareImages(audioJobs.map((image) => ({ image, preview: false })), archive, ctx)
  } catch {
    // The request can still continue if the archive is unavailable.
  }
  const audioOriginals = new Map(audioJobs.map((clip, index) => [clip, audioReferences[index]]))
  for (const clip of audio) {
    const original = audioOriginals.get(clip)
    const path = original?.path || (archive ? clip.path : "")
    const command = restoreCommand(ctx, archive, original?.sha256)
    const recovery = command
      ? `${path ? "If the file is missing, run" : "To recover the file, run"} this local PowerShell command and use the returned file path: ${command} .`
      : ""
    clip.set(audioPlaceholder(path, recovery))
  }
  const size = () => {
    const media = collect(body, ctx.protocol)
    return requestBytes(body, [...media.images, ...media.audio])
  }
  const afterAudio = audio.length ? size() : before
  if (policy.log && audio.length) console.log(`image-slim audio: ${before} -> ${afterAudio} bytes, ${audio.length} audio items replaced with references`)
  const changed = hasLegacyPath || audio.length > 0
  const currentStart = turnStart(found.turns, 1)
  const dispatched = currentStart >= 0 && found.latestDispatch === currentStart
  if (!imageRoute || !found.images.length || (!dispatched && afterAudio < policy.trigger_bytes)) return changed ? body : undefined
  let budget = Math.max(Math.floor(policy.request_budget_bytes * 0.95), policy.request_budget_bytes - FORWARDING_MARGIN)
  // The plugin host reads a complete hook reply as one line, with a 32 MiB limit.
  if (dispatched) budget = Math.min(budget, DISPATCH_HOOK_BUDGET)
  const previousTurns = Number.isSafeInteger(ctx.options.preview_turns) ? Math.max(0, ctx.options.preview_turns) : 5
  const historyStart = turnStart(found.turns, 1 + previousTurns)
  if (currentStart < 0) return changed ? body : undefined

  const originals = currentImages(found)
  const current = [...originals]
  const historical = found.images.filter((image) => !originals.has(image))
  const prepared = historical.map((image) => ({
    image, preview: image.index >= historyStart && image.bytes > MAX_PREVIEW_BYTES,
  }))
  const jobs = prepared.filter(({ image, preview }) => preview || (archive && image.index < historyStart))
  const results = await prepareImages(jobs, archive, ctx)
  const encoded = new Map(jobs.map(({ image }, index) => [image, results[index]]))
  const previews = new Map()
  const omitted = new Set()

  function reference(image) {
    const archivePath = encoded.get(image)?.path
    return archivePath || (archive ? image.path : "")
  }
  function originalInstruction(image) {
    const path = reference(image)
    const command = restoreCommand(ctx, archive, encoded.get(image)?.sha256)
    const open = path ? `Use view_image to reopen the original at ${JSON.stringify(path)}.` : ""
    if (command) {
      const condition = path ? "If that file is missing or cannot be opened, run" : "To recover the original, run"
      return `${open ? open + " " : ""}${condition} this PowerShell command: ${command} . Then use view_image on the returned path. Ask for reattachment only if the local recovery fails.`
    }
    return open || "If you need the full resolution original, ask the user to reattach it."
  }
  function omit(image) {
    const recovery = restoreCommand(ctx, archive, encoded.get(image)?.sha256)
    const text = recovery
      ? `[Historical image omitted from this request. ${originalInstruction(image)}]`
      : placeholder(policy, { ...image, path: reference(image) })
    image.set(text)
    omitted.add(image)
    previews.delete(image)
  }
  function displayPreview(image) {
    const url = encoded.get(image)?.url
    if (typeof url !== "string" || url.length > MAX_PREVIEW_BYTES || !url.startsWith("data:image/jpeg;base64,")) return false
    image.replaceUrl(url)
    previews.set(image, url.length)
    return true
  }
  for (const { image, preview } of prepared) {
    if (image.index < historyStart || (preview && !displayPreview(image))) omit(image)
  }
  let after = size()
  if (after > budget) {
    let projected = after
    for (const image of historical) {
      if (projected <= budget) break
      if (omitted.has(image)) continue
      // A small image may be cheaper to keep than its replacement text.
      const saving = (previews.get(image) ?? image.bytes) - 1024
      if (saving <= 0) continue
      omit(image)
      projected -= saving
    }
    after = size()
  }
  if (after > budget) {
    const resizeCurrent = current.filter((image) => image.bytes > MAX_PREVIEW_BYTES)
    const smaller = await prepareImages(resizeCurrent.map((image) => ({ image, preview: true })), archive, ctx)
    for (const [index, image] of resizeCurrent.entries()) {
      encoded.set(image, smaller[index])
      displayPreview(image)
    }
  }

  for (const image of previews.keys()) {
    image.describe(`[Magpie preview of the preceding image. Other unmarked images are originals. For exact details, ${originalInstruction(image)}]`)
  }
  after = size()
  const currentPreviews = current.filter((image) => previews.has(image)).length
  const kept = historical.length - omitted.size
  const stored = [...encoded.values()].filter((entry) => entry?.path).length
  if (policy.log && (omitted.size || previews.size)) {
    console.log(`image-preview: ${before} -> ${after} bytes, ${kept} historical images kept (${previews.size - currentPreviews} previews), ${omitted.size} omitted, ${current.length - currentPreviews}/${current.length} current originals, ${stored} original references${dispatched ? ", Codex dispatch" : ""}`)
  }
  ctx.report?.("image-preview", after)
  if (omitted.size || previews.size || changed) return body
}
