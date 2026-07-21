// A minimal, dependency-free search widget over /search-index.json (see
// src/search.js for how that file is built and why matching happens here
// in plain JS rather than in nisaba itself). Ranks by word overlap with a
// small boost for title matches — not BM25, but real and self-contained.
(() => {
  const STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in',
    'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or', 'such', 'that', 'the',
    'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'will',
    'with',
  ]);

  const tokenize = (text) =>
    [...new Set(
      String(text)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    )];

  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');
  if (!input || !results) return;

  let records = null;
  const ready = fetch('/search-index.json')
    .then((res) => res.json())
    .then((data) => { records = data; });

  const render = (query) => {
    const tokens = tokenize(query);
    if (tokens.length === 0) {
      results.replaceChildren();
      return;
    }
    const scored = records
      .map((r) => {
        const overlap = tokens.filter((t) => r.words.includes(t)).length;
        const titleBoost = tokens.some((t) => r.title.toLowerCase().includes(t)) ? 1 : 0;
        return { r, score: overlap + titleBoost };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    results.replaceChildren(
      ...scored.map(({ r }) => {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = r.url;
        a.textContent = r.title;
        li.append(a, document.createTextNode(` — ${r.excerpt}`));
        return li;
      })
    );
  };

  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await ready;
      render(input.value);
    }, 100);
  });
})();
