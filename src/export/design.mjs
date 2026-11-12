import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const typeRoles = {
  body: "Body", p: "Paragraph", h1: "H1", h2: "H2", h3: "H3",
  h4: "H4", h5: "H5", h6: "H6", button: "Button", a: "Link",
  input: "Input", textarea: "Textarea", select: "Select", label: "Label",
};

const componentRoles = {
  header: "Header", nav: "Navigation", footer: "Footer",
  section: "Section", article: "Article", form: "Form", button: "Button",
  a: "Link", input: "Input", textarea: "Textarea", select: "Select", tab: "Tab",
  tablist: "Tab list", img: "Image", video: "Video", canvas: "Canvas",
};

const escape = (value) => String(value).replace(/\s+/g, " ").trim().slice(0, 180)
  .replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character])
  .replace(/[\\`*_[\]|~]/g, "\\$&");

function rows(values) {
  return values.map((cells) => "| " + cells.map((cell) => cell ? escape(cell) : "—").join(" | ") + " |");
}

function withinViewport(item, [width, height]) {
  const [x, y, w, h] = item.box ?? [];
  return w > 0 && h > 0 && x < width && y < height && x + w > 0 && y + h > 0 && item.opacity !== "0";
}

function addVariant(groups, role, values, example) {
  if (!role || !values.some(Boolean)) return;
  const variants = groups.get(role) ?? new Map();
  const key = JSON.stringify(values);
  if (!variants.has(key) && variants.size < 5) variants.set(key, [role, ...values, example]);
  groups.set(role, variants);
}

function addColor(palette, role, value, example) {
  if (!value || value === "transparent" || value === "rgba(0, 0, 0, 0)") return;
  const key = JSON.stringify([role, value]);
  const color = palette.get(key) ?? { role, value, example, uses: 0 };
  color.uses++;
  palette.set(key, color);
}

function collectDesign(archive) {
  const typography = new Map(), components = new Map(), palette = new Map();
  const seen = new Set();
  function add(item, source) {
    const tag = item.tag?.toLowerCase();
    const role = item.role || tag;
    const name = item.label || item.section || tag;
    const example = [name, source].filter(Boolean).join(" · ");
    const css = item.css ?? {};
    const value = (camel, dashed = camel) => css[camel] ?? css[dashed] ?? item[camel];
    const type = [value("fontFamily", "font-family"), value("fontSize", "font-size"),
      value("lineHeight", "line-height"), value("fontWeight", "font-weight"),
      value("letterSpacing", "letter-spacing")];
    const shape = [value("display"), value("gap"), value("padding"),
      value("borderRadius", "border-radius"), value("position")];
    const colors = [value("color"), value("backgroundColor", "background-color")];
    const key = JSON.stringify([role, name, type, shape, colors]);
    if (seen.has(key)) return;
    seen.add(key);
    const typeRole = Object.hasOwn(typeRoles, role) ? typeRoles[role] : Object.hasOwn(typeRoles, tag) && typeRoles[tag];
    addVariant(typography, typeRole, type, example);
    addVariant(components, Object.hasOwn(componentRoles, role) && componentRoles[role], shape, example);
    addColor(palette, "Text color", colors[0], example);
    addColor(palette, "Surface color", colors[1], example);
  }

  const samples = archive.samples ?? [];
  for (const sample of samples) {
    const viewport = sample.viewport ?? [archive.viewport?.width, archive.viewport?.height];
    const source = Number.isFinite(sample.scrollY) ? `scroll Y ${sample.scrollY}px` : "";
    // Prefer richer samples where present. Older captures keep their measured layout.
    for (const item of sample.design ?? sample.layout ?? []) {
      if (withinViewport(item, viewport)) add(item, source);
    }
  }
  const hasDesignSamples = samples.some(({ design }) => design?.length);
  if (!hasDesignSamples) {
    for (const { target, samples: observations } of archive.motion?.styles ?? []) {
      const observation = observations.find(({ visible }) => visible);
      if (observation) add({ ...target, css: observation.css }, "motion style sample");
    }
  }
  return {
    typography: [...typography.values()].flatMap((variants) => [...variants.values()]),
    components: [...components.values()].flatMap((variants) => [...variants.values()]),
    palette: [...palette.values()].sort((a, b) => b.uses - a.uses),
  };
}

export async function writeDesign(output, archive, scenes) {
  const design = collectDesign(archive);
  const { width, height } = archive.viewport ?? {};
  const viewport = Number.isFinite(width) && Number.isFinite(height) ? `${width} × ${height} CSS px` : "Unavailable";
  const capturedActions = (archive.actions ?? []).filter(({ frames }) => frames?.some(({ phase }) => phase === 100)).length;
  const lines = [
    "# Design reference", "",
    `Source page · ${escape(archive.url)}`,
    `Recorded viewport · ${viewport}`, "",
    "Use these measurements to extend the exported page’s visual style. Map the observed values to the destination project’s existing tokens and component variants. Use the same heading hierarchy, spacing, and control shapes for equivalent roles.", "",
    "## Palette", "",
    ...(design.palette.length ? [
      "Computed colors observed in the sampled page. Review the example and its surrounding surface before assigning a semantic token.", "",
      "| Use in the capture | CSS value | Example |",
      "| --- | --- | --- |",
      ...rows(["Text color", "Surface color"].flatMap((role) => design.palette.filter((color) => color.role === role)
        .slice(0, 6).map(({ role, value, example }) => [role, value, example]))),
    ] : ["Computed colors are unavailable in this capture. Inspect the local preview before defining palette tokens."]), "",
    "## Typography", "",
    ...(design.typography.length ? [
      "| Role | Family stack | Size | Line height | Weight | Tracking | Example |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...rows(design.typography),
    ] : ["Typography measurements are unavailable in this capture."]), "",
    "## Layout and components", "",
    ...(design.components.length ? [
      "Each row represents an observed variant. Use the linked page map to check alignment, content width, and section composition in context.", "",
      "| Role | Display | Gap | Padding | Radius | Position | Example |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...rows(design.components),
    ] : ["Component measurements are unavailable in this capture."]), "",
    "## Responsive behavior and interaction", "",
    "- Treat the recorded viewport as the verified layout size. Check the export at other widths before documenting breakpoints or building responsive variants.",
    `- Recorded actions with an end checkpoint · ${capturedActions}. Use [interactions](manifest/interactions.json) to identify covered states and [motion](manifest/motion-manifest.json) for timing and easing. Check keyboard focus and reduced-motion behavior in the destination.`,
    ...(scenes ? ["- Use the [scene guide](guide/scenes.md) for animated backgrounds and Canvas evidence."] : []), "",
    "## Evidence", "",
    "- [Page map and screenshots](guide/page.md)",
    "- [Viewport and sampled layout](manifest/page.json)",
    "- [Computed motion target styles](manifest/styles.json)",
    "- [Asset and font inventory](manifest/assets.json)",
    "- [Capture gaps](manifest/missing.json)", "",
  ];
  await writeFile(join(output, "design.md"), lines.join("\n"));
}
