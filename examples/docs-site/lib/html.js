// Fragment builders for layouts/base.mdy — sidebar, "On this page" outline,
// and prev/next pager.
//
// These used to concatenate strings of HTML, which the layout then
// interpolated and something downstream had to parse back. They build hast
// now: plain JSON objects, which is what a tree is, so they cross into the
// host through $.node() as themselves. Nothing escapes them either — a
// fragment with a tag left open is not a thing that can be built this way,
// and `esc` is gone because there is no longer any text being pasted into
// markup where it could mean something.

const el = (tagName, properties, children) => ({
  type: "element",
  tagName,
  properties: properties ?? {},
  children: children ?? [],
});

const text = (value) => ({ type: "text", value: String(value) });

const link = (className, href, children) => el("a", { className, href }, children);

export function sidebar(groups, activeUrl) {
  if (!groups || groups.length === 0) { return null; }
  return el(
    "nav",
    { className: ["sidebar-nav"] },
    groups.map((g) =>
      el("section", { className: ["sidebar-group"] }, [
        el("p", { className: ["sidebar-group-title"] }, [text(g.text)]),
        el(
          "ul",
          {},
          g.items.map((it) =>
            el("li", {}, [
              link(
                it.link === activeUrl ? ["sidebar-link", "active"] : ["sidebar-link"],
                it.link,
                [text(it.text)]
              ),
            ])
          )
        ),
      ])
    )
  );
}

export function outline(entries) {
  if (!entries || entries.length === 0) { return null; }
  // An h3 belongs to the h2 above it, so the list is built by hanging each
  // sub-item off the item still open rather than by opening and closing tags.
  const items = [];
  for (const e of entries) {
    const anchor = link(["outline-link"], "#" + e.slug, [text(e.text)]);
    if (e.depth === 2 || items.length === 0) {
      items.push(el("li", {}, [anchor]));
    } else {
      const open = items[items.length - 1];
      let sub = open.children[open.children.length - 1];
      if (!sub || sub.tagName !== "ul") {
        sub = el("ul", { className: ["outline-sub"] }, []);
        open.children.push(sub);
      }
      sub.children.push(el("li", {}, [anchor]));
    }
  }
  return el("nav", { className: ["outline"], id: "outline" }, [
    el("p", { className: ["outline-title"] }, [text("On this page")]),
    el("ul", { className: ["outline-list"] }, items),
  ]);
}

export function prevNext(prev, next) {
  if (!prev && !next) { return null; }
  const pager = (item, kind, desc) =>
    el("div", { className: ["pager"] }, item
      ? [
          link(["pager-link", kind], item.link, [
            el("span", { className: ["pager-desc"] }, [text(desc)]),
            el("span", { className: ["pager-title"] }, [text(item.text)]),
          ]),
        ]
      : []);
  return el("nav", { className: ["prev-next"] }, [
    pager(prev, "prev", "Previous page"),
    pager(next, "next", "Next page"),
  ]);
}
