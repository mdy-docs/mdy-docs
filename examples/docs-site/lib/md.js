// Markdown-text transforms for the docs site: VitePress-style `::: tip`
// containers, internal-link rewriting to this site's directory URLs,
// excerpts, and date formatting — all pure string work, run inside the
// sandboxed VM.

export function stripFrontMatter(body) {
  return String(body).replace(/^---\n[\s\S]*?\n---\n?/, "");
}

// ::: tip Custom title   →   <div class="custom-block tip"> … </div>
// Content between the fences stays markdown (blank-line separated from the
// raw HTML, so remark still renders it; rehype-raw stitches the div back).
export function transformContainers(md) {
  const out = [];
  for (const line of String(md).split("\n")) {
    const open = /^:::\s*(tip|info|warning|danger|details)\s*(.*)$/.exec(line);
    if (open) {
      const kind = open[1];
      const title = open[2] !== "" ? open[2] : kind.toUpperCase();
      out.push('<div class="custom-block ' + kind + '">');
      out.push('<p class="custom-block-title">' + title + "</p>");
      out.push("");
      continue;
    }
    if (/^:::\s*$/.test(line)) {
      out.push("");
      out.push("</div>");
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

// VitePress pages link to each other extension-less (`/guide/language`);
// this site emits directory URLs (`/guide/language/`), so add the trailing
// slash to any internal link that isn't a real file.
export function rewriteLinks(md) {
  return String(md).replace(/\]\((\/[^)#\s]*)((?:#[^)]*)?)\)/g, function (m0, path, hash) {
    const last = path.slice(path.lastIndexOf("/") + 1);
    const fixed = last === "" || last.indexOf(".") !== -1 ? path : path + "/";
    return "](" + fixed + hash + ")";
  });
}

export function excerpt(md) {
  return String(md)
    .replace(/^#.*$/m, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/[#*_>`\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// mtime crosses into the VM as an ISO string (context is JSON); the VM has
// no Date constructor, so format it with plain string work.
export function formatDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) { return ""; }
  return MONTHS[parseInt(m[2], 10) - 1] + " " + parseInt(m[3], 10) + ", " + m[1];
}
