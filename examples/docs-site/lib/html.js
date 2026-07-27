// HTML fragment builders for layouts/base.mdy — sidebar, "On this page"
// outline, and prev/next pager. Built as single-line strings in script code
// so the layout stays a readable shell.

export function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function sidebarHtml(groups, activeUrl) {
  if (!groups || groups.length === 0) { return ""; }
  let h = '<nav class="sidebar-nav">';
  for (const g of groups) {
    h += '<section class="sidebar-group"><p class="sidebar-group-title">' + esc(g.text) + "</p><ul>";
    for (const it of g.items) {
      h += '<li><a class="sidebar-link' + (it.link === activeUrl ? " active" : "") + '" href="' + it.link + '">' + esc(it.text) + "</a></li>";
    }
    h += "</ul></section>";
  }
  return h + "</nav>";
}

export function outlineHtml(entries) {
  if (!entries || entries.length === 0) { return ""; }
  let h = '<nav class="outline" id="outline"><p class="outline-title">On this page</p><ul class="outline-list">';
  let liOpen = false;
  let subOpen = false;
  for (const e of entries) {
    if (e.depth === 2) {
      if (subOpen) { h += "</ul>"; subOpen = false; }
      if (liOpen) { h += "</li>"; }
      h += '<li><a class="outline-link" href="#' + e.slug + '">' + esc(e.text) + "</a>";
      liOpen = true;
    } else if (liOpen) {
      if (!subOpen) { h += '<ul class="outline-sub">'; subOpen = true; }
      h += '<li><a class="outline-link" href="#' + e.slug + '">' + esc(e.text) + "</a></li>";
    }
  }
  if (subOpen) { h += "</ul>"; }
  if (liOpen) { h += "</li>"; }
  return h + "</ul></nav>";
}

export function prevNextHtml(prev, next) {
  if (!prev && !next) { return ""; }
  let h = '<nav class="prev-next">';
  h += '<div class="pager">';
  if (prev) {
    h += '<a class="pager-link prev" href="' + prev.link + '"><span class="pager-desc">Previous page</span><span class="pager-title">' + esc(prev.text) + "</span></a>";
  }
  h += '</div><div class="pager">';
  if (next) {
    h += '<a class="pager-link next" href="' + next.link + '"><span class="pager-desc">Next page</span><span class="pager-title">' + esc(next.text) + "</span></a>";
  }
  h += "</div>";
  return h + "</nav>";
}
