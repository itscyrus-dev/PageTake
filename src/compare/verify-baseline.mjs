import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const manifestName = "baseline.json";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function stateContract(section, index) {
  const sequence = section.states.slice(0, index + 1).map((state) => ({
    id: state.id, action: state.action, target: state.target?.reference ?? section.selectors.reference,
    framesMs: state.framesMs,
  }));
  const assertions = (section.states[index].expect ?? []).map((entry) => ({
    label: entry.label, selector: entry.selectors.reference, visibleCount: entry.visibleCount,
  }));
  return digest(JSON.stringify({ selector: section.selectors.reference, sequence, assertions }));
}

export async function saveVerificationBaseline(plan, output, capture) {
  const sections = [];
  for (const [i, section] of plan.sections.entries()) {
    const states = [];
    for (const [j, state] of section.states.entries()) {
      const observation = capture.sections[i][j];
      const frames = [];
      for (const frame of observation.frames) {
        frames.push(frame.file
          ? { ...frame, sha256: digest(await readFile(join(output, frame.file))) }
          : frame);
      }
      states.push({ ...observation, id: state.id, contract: stateContract(section, j), frames });
    }
    sections.push({ id: section.id, states });
  }
  const baseline = {
    version: 1, id: randomUUID(), reference: plan.reference, capturedAt: capture.capturedAt,
    environment: capture.environment, sections,
  };
  await writeFile(join(output, manifestName), JSON.stringify(baseline, null, 2) + "\n", { flag: "wx" });
  return baseline;
}

function validObservation(frame) {
  return Number.isFinite(frame.elapsedMs) && Array.isArray(frame.assertions) &&
    frame.assertions.every((entry) => typeof entry?.label === "string" && Number.isInteger(entry.actual) &&
      Number.isInteger(entry.expected) && typeof entry.passed === "boolean") &&
    Array.isArray(frame.animations) && frame.animations.every((entry) => entry && typeof entry === "object");
}

async function restoreFrame(folder, output, frame, atMs, name) {
  if (!frame) return { atMs, error: "Saved baseline is missing this frame" };
  if (typeof frame.error === "string") return { atMs, error: frame.error };
  if (!/^reference-\d+-\d+-\d+\.png$/.test(frame.file ?? "") || !validObservation(frame)) {
    return { atMs, error: "Saved baseline frame metadata is invalid" };
  }
  const path = join(folder, frame.file);
  let bytes;
  try {
    if (!(await lstat(path)).isFile()) throw new Error("Expected a regular file");
    bytes = await readFile(path);
  } catch {
    return { atMs, error: "Saved baseline screenshot is unavailable" };
  }
  if (digest(bytes) !== frame.sha256) return { atMs, error: "Saved baseline screenshot checksum does not match" };
  await writeFile(join(output, name), bytes);
  return { ...frame, file: name };
}

function readBaselineEnvironment(environment) {
  const { browser, platform, osRelease, architecture, headless, width, height, devicePixelRatio, reducedMotion } = environment ?? {};
  if (![browser, platform, osRelease, architecture].every((value) => typeof value === "string") ||
      ![headless, reducedMotion].every((value) => typeof value === "boolean") ||
      ![width, height, devicePixelRatio].every(Number.isFinite)) {
    throw new Error("Invalid baseline browser environment");
  }
  return environment;
}

export async function loadVerificationBaseline(plan, folder, output) {
  const path = join(folder, manifestName);
  const baseline = JSON.parse(await readFile(path, "utf8"));
  if (baseline?.version !== 1 || typeof baseline.id !== "string" ||
      typeof baseline.reference !== "string" || !Number.isFinite(Date.parse(baseline.capturedAt)) ||
      !Array.isArray(baseline.sections)) throw new Error("Invalid verification baseline");
  if (baseline.reference !== plan.reference) throw new Error("Baseline reference URL differs from the verification plan");
  const environment = readBaselineEnvironment(baseline.environment);
  const incompatible = environment.width !== plan.viewport.width || environment.height !== plan.viewport.height ||
    environment.devicePixelRatio !== 1 || environment.reducedMotion !== plan.reducedMotion;
  const sections = [];
  for (const [i, section] of plan.sections.entries()) {
    const saved = baseline.sections.find((item) => item?.id === section.id);
    const states = [];
    for (const [j, state] of section.states.entries()) {
      const observation = Array.isArray(saved?.states) && saved.states.find((item) => item?.id === state.id);
      if (incompatible || !observation || observation.contract !== stateContract(section, j)) {
        states.push({ frames: [], error: incompatible ? "Saved baseline viewport or motion preference differs from the plan"
          : !observation ? "State is missing from the saved baseline" : "Reference checks have changed since the baseline was saved" });
        continue;
      }
      if (typeof observation.error === "string") {
        states.push({ frames: [], error: observation.error });
        continue;
      }
      const frames = [];
      for (const [k, atMs] of state.framesMs.entries()) {
        const frame = Array.isArray(observation.frames) && observation.frames.find((item) => item?.atMs === atMs);
        frames.push(await restoreFrame(folder, output, frame, atMs, `reference-${i + 1}-${j + 1}-${k + 1}.png`));
      }
      states.push({ frames });
    }
    sections.push(states);
  }
  return { sections, environment, capturedAt: baseline.capturedAt, source: { type: "saved", id: baseline.id, manifest: path } };
}
