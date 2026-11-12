import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { publicUrl } from "../capture/archive.mjs";
import { resourcePath } from "./verify-assets.mjs";

const slug = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function selector(value) {
  return typeof value === "string" && value.trim() && value.length <= 500;
}

function integer(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

export async function readVerifyPlan(file, { referenceOnly = false } = {}) {
  const plan = JSON.parse(await readFile(file, "utf8"));
  const sides = referenceOnly ? ["reference"] : ["reference", "candidate"];
  const targets = (value) => sides.every((side) => selector(value?.[side]));
  const { viewport, sections, minVisual = 90, maxSizeDelta = 4, maxTimingDeltaMs = 100, readyTimeoutMs = 10000, reducedMotion = false } = plan ?? {};
  check(plan?.version === 1, "Verification plan must have version 1");
  check(sides.every((side) => typeof plan[side] === "string" && publicUrl(plan[side])),
    "Page URLs must use HTTP(S) without credentials or signed parameters");
  check(integer(viewport?.width, 320, 3840) && integer(viewport?.height, 240, 2160), "Invalid verification viewport");
  check(Number.isFinite(minVisual) && minVisual >= 0 && minVisual <= 100, "Invalid minVisual");
  check(integer(maxSizeDelta, 0, 2160), "Invalid maxSizeDelta");
  check(integer(maxTimingDeltaMs, 0, 1000), "Invalid maxTimingDeltaMs");
  check(integer(readyTimeoutMs, 1000, 120000), "Invalid readyTimeoutMs");
  check(typeof reducedMotion === "boolean", "Invalid reducedMotion");
  check(Array.isArray(sections) && sections.length > 0 && sections.length <= 20, "Specify 1–20 sections");
  const sectionIds = new Set();
  for (const section of sections) {
    check(typeof section?.id === "string" && slug.test(section.id) && !sectionIds.has(section.id),
      "Section IDs must be unique lowercase slugs");
    sectionIds.add(section.id);
    check(targets(section.selectors), `${section.id}: supply selectors for ${sides.join(" and ")}`);
    const layers = section.layers ?? [];
    const layerIds = new Set(["section"]);
    check(Array.isArray(layers) && layers.length <= 8, `${section.id}: specify up to 8 visual layers`);
    for (const layer of layers) {
      check(typeof layer?.id === "string" && slug.test(layer.id) && !layerIds.has(layer.id) && targets(layer.selectors),
        `${section.id}: visual layers require unique IDs and selectors`);
      check(layer.pseudo === undefined || ["::before", "::after"].includes(layer.pseudo),
        `${section.id}/${layer.id}: invalid pseudo-element`);
      check(layer.referenceFiles === undefined || (plan.sourceExport && Array.isArray(layer.referenceFiles) &&
        layer.referenceFiles.length <= 12 && layer.referenceFiles.every(resourcePath)),
        `${section.id}/${layer.id}: referenceFiles require sourceExport and paths under resources/`);
      layerIds.add(layer.id);
    }
    check(Array.isArray(section.states) && section.states.length > 0 && section.states.length <= 12,
      `${section.id}: specify 1–12 states`);
    const stateIds = new Set();
    for (const state of section.states) {
      check(typeof state?.id === "string" && slug.test(state.id) && !stateIds.has(state.id),
        `${section.id}: state IDs must be unique lowercase slugs`);
      stateIds.add(state.id);
      const label = `${section.id}/${state.id}`;
      check(["idle", "hover", "leave", "click", "focus", "wait"].includes(state.action), `${label}: invalid action`);
      check(state.target === undefined || (["hover", "click", "focus"].includes(state.action) && targets(state.target)),
        `${label}: invalid action target`);
      check(Array.isArray(state.framesMs) && state.framesMs.length > 0 && state.framesMs.length <= 8 &&
        state.framesMs.every((ms, index) => integer(ms, 0, 10000) && (!index || ms > state.framesMs[index - 1])),
      `${label}: framesMs must contain 1–8 increasing offsets from 0 to 10000`);
      check(state.expect === undefined || (Array.isArray(state.expect) && state.expect.length <= 12 &&
        state.expect.every((entry) => typeof entry?.label === "string" && entry.label.trim() &&
          targets(entry.selectors) && integer(entry.visibleCount, 0, 1000))),
      `${label}: invalid visibility assertion`);
    }
  }
  check(plan.sourceExport === undefined || (typeof plan.sourceExport === "string" && plan.sourceExport.trim()),
    "sourceExport must be a directory path");
  const sourceExport = plan.sourceExport && resolve(dirname(file), plan.sourceExport);
  return { ...plan, minVisual, maxSizeDelta, maxTimingDeltaMs, readyTimeoutMs, reducedMotion, sourceExport };
}
