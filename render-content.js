const markdownContent = (() => {
  const tags = ('p br hr h1 h2 h3 h4 h5 h6 pre code blockquote ul ol li strong b em i s del u sub sup ' +
    'a img table thead tbody tfoot tr th td input div span details summary kbd mark').split(' ');
  const attributes = 'href src alt title class start align colspan rowspan checked disabled type open'.split(' ');
  const mathOptions = {
    delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }],
    trust: false, throwOnError: false
  };
  let diagramId = 0;

  function safeUrl(value, base, image = false) {
    if (!value) return null;
    if (image && /^data:image\/(?:png|gif|jpeg|webp|bmp|avif|svg\+xml);base64,[a-z0-9+/=]+$/i.test(value)) {
      return value;
    }
    try {
      const url = new URL(value, base);
      if (url.protocol === 'http:' || url.protocol === 'https:' ||
          (!image && url.protocol === 'mailto:')) return url.href;
      if (url.protocol === 'file:' && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(value)) return value;
    } catch (_) {}
    return null;
  }

  function fragment(text) {
    const container = document.createElement('div');
    if (!window.marked || !window.DOMPurify) {
      const pre = document.createElement('pre');
      pre.textContent = text;
      container.append(pre);
      return container;
    }
    const nonce = Math.random().toString(36).slice(2);
    const numberNonce = 'md-number-token-' + nonce + '-';
    const numbering = editorNumbering.annotate(text, numberNonce);
    const formulas = [];
    const source = numbering.source.split(/(\x60{3,}[\s\S]*?\x60{3,}|~{3,}[\s\S]*?~{3,}|\x60+[^\n]*?\x60+)/g).map((part, index) =>
      index % 2 ? part : part.replace(/\$\$[\s\S]+?\$\$|(?<!\\)\$[^$\n]+?\$/g, formula => {
        const token = 'MATH' + nonce + 'x' + formulas.length + 'END';
        formulas.push(formula);
        return token;
      })
    ).join('');
    const listNonce = 'md-list-token-' + nonce + '-';
    const lists = editorListFormat.normalize(source, listNonce);
    const html = marked.parse(lists.source, { gfm: true, breaks: true });
    container.append(DOMPurify.sanitize(html, {
      ALLOWED_TAGS: tags, ALLOWED_ATTR: attributes, ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false, RETURN_DOM_FRAGMENT: true
    }));
    editorListFormat.restoreLists(container, listNonce, lists.rows);
    editorNumbering.decorate(container, numberNonce, numbering.rows);
    for (const heading of container.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      const list = document.createElement('ul');
      const item = document.createElement('li');
      item.append(...heading.childNodes);
      list.append(item);
      heading.replaceWith(list);
    }
    const font = editorListFormat.font(text);
    if (font) container.style.fontFamily = '"' + font + '", sans-serif';
    for (const link of container.querySelectorAll('a[href],img[src]')) {
      const image = link.tagName === 'IMG';
      const attr = image ? 'src' : 'href';
      if (!safeUrl(link.getAttribute(attr), document.baseURI, image)) link.removeAttribute(attr);
    }
    for (const input of container.querySelectorAll('input')) {
      if (input.type !== 'checkbox') input.remove();
      else input.disabled = true;
    }
    if (formulas.length) {
      const pattern = new RegExp('MATH' + nonce + 'x(\\d+)END', 'g');
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        node.nodeValue = node.nodeValue.replace(pattern, (_, index) => formulas[index]);
      }
    }
    return container;
  }

  async function diagrams(body) {
    const blocks = [...body.querySelectorAll('pre > code.language-mermaid')];
    if (!blocks.length || !window.mermaid) return false;
    let failed = false;
    for (const code of blocks) {
      try {
        const { svg } = await mermaid.render('md-diagram-' + ++diagramId, code.textContent);
        const image = document.createElement('img');
        image.className = 'mermaid-diagram';
        image.alt = 'Mermaid';
        // SVG image documents cannot execute scripts or load external resources.
        const sanitized = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['foreignObject', 'a']
        });
        if (!sanitized.startsWith('<svg')) throw new Error('Invalid diagram');
        image.src = 'data:image/svg+xml;base64,' +
          btoa(Array.from(new TextEncoder().encode(sanitized), byte => String.fromCharCode(byte)).join(''));
        code.parentElement.replaceWith(image);
      } catch (_) {
        document.getElementById('dmd-diagram-' + diagramId)?.remove();
        failed = true;
      }
    }
    return failed;
  }

  return { fragment, diagrams, safeUrl, mathOptions };
})();
