const editorListFormat = (() => {
  const styles = {};
  function ordered(id, css, word, prefix, suffix, examples) {
    styles[id] = { id, css, word, prefix, suffix, examples: examples.map(value => prefix + value + suffix) };
  }
  ordered('decimal-dot', 'decimal', 'decimal', '', '.', ['1', '2']);
  ordered('decimal-right', 'decimal', 'decimal', '', ')', ['1', '2']);
  ordered('decimal-parens', 'decimal', 'decimal', '(', ')', ['1', '2']);
  ordered('decimal-wide', 'decimal', 'decimal', '（', '）', ['1', '2']);
  ordered('decimal-wide-right', 'decimal', 'decimal', '', '）', ['1', '2']);
  ordered('decimal-comma', 'decimal', 'decimal', '', '、', ['1', '2']);
  ordered('upper-alpha', 'upper-alpha', 'upperLetter', '', '.', ['A', 'B']);
  ordered('lower-alpha', 'lower-alpha', 'lowerLetter', '', '.', ['a', 'b']);
  ordered('upper-roman', 'upper-roman', 'upperRoman', '', '.', ['I', 'II']);
  ordered('lower-roman', 'lower-roman', 'lowerRoman', '', '.', ['i', 'ii']);
  const families = [
    ['upper-alpha', 'upper-alpha', 'upperLetter', ['A', 'B']],
    ['lower-alpha', 'lower-alpha', 'lowerLetter', ['a', 'b']],
    ['upper-roman', 'upper-roman', 'upperRoman', ['I', 'II']],
    ['lower-roman', 'lower-roman', 'lowerRoman', ['i', 'ii']],
    ['chinese', 'simp-chinese-informal', 'chineseCountingThousand', ['一', '二']],
    ['chinese-formal', 'simp-chinese-formal', 'chineseLegalSimplified', ['壹', '贰']],
    ['chinese-traditional', 'trad-chinese-formal', 'ideographLegalTraditional', ['壹', '貳']]
  ];
  const orderedMenu = Object.keys(styles);
  for (const [id, css, word, examples] of families) {
    for (const [form, prefix, suffix] of [['right', '', ')'], ['wide-right', '', '）'], ['parens', '(', ')'],
      ['wide', '（', '）'], ['comma', '', '、'], ['dot', '', '.']]) {
      const key = form === 'dot' && styles[id] ? id : id + '-' + form;
      ordered(key, css, word, prefix, suffix, examples);
    }
  }
  orderedMenu.push('chinese-comma', 'chinese-formal-comma', 'chinese-traditional-comma', 'chinese-wide',
    'lower-alpha-right', 'upper-alpha-parens', 'lower-roman-parens');
  const bullets = { disc: '•', circle: '○', square: '▪', dash: '–', diamond: '◆', arrow: '➤', check: '✓' };
  for (const [id, symbol] of Object.entries(bullets)) styles[id] = { id, symbol, word: 'bullet', examples: [symbol, symbol] };

  const chineseDigits = ['零〇', '一壹', '二贰貳两兩', '三叁參', '四肆', '五伍', '六陆陸', '七柒', '八捌', '九玖'];
  const chineseUnits = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000, 万: 10000, 萬: 10000 };
  const numerals = new RegExp('^(?:\\d{1,9}|[A-Z]{1,8}|[a-z]{1,8}|[' +
    chineseDigits.join('') + Object.keys(chineseUnits).join('') + ']+)$');
  const romanDigits = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  const validRoman = /^M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;
  const forms = { '.': 'dot', '．': 'dot', '、': 'comma', ')': 'right', '）': 'wide-right', '()': 'parens', '（）': 'wide' };
  const symbols = { '•': 'disc', '●': 'disc', '○': 'circle', '◦': 'circle', '▪': 'square', '■': 'square',
    '–': 'dash', '—': 'dash', '◆': 'diamond', '➤': 'arrow', '✓': 'check' };
  const fontHeader = /^<!-- md-font: ([^\n]+) -->\r?\n(?:\r?\n)?/;

  function validFont(name) {
    return /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} ._'&-]{0,79}$/u.test(name);
  }

  function font(text) {
    const name = text.match(fontHeader)?.[1];
    return name && validFont(name) ? name : '';
  }

  function chineseNumber(value) {
    let total = 0, group = 0, digits = 0;
    for (const character of value) {
      const unit = chineseUnits[character];
      if (!unit) digits = digits * 10 + chineseDigits.findIndex(set => set.includes(character));
      else if (unit === 10000) {
        total += (group + digits || 1) * unit;
        group = digits = 0;
      } else {
        group += (digits || 1) * unit;
        digits = 0;
      }
    }
    return total + group + digits;
  }

  function row(line) {
    const match = /^([ \t]*)(?:([-+*•●○◦▪■–—◆➤✓])(?=[ \t]|$)|(\([^)]+\)|（[^）]+）|[^ \t.．、)）]+[.．、)）]))([ \t]*)(.*)$/.exec(line);
    if (!match) return null;
    const [, whitespace, bullet, number, space, tail] = match;
    const indent = [...whitespace].reduce((count, character) => count + (character === '\t' ? 4 - count % 4 : 1), 0);
    const meta = /^<!-- md-list:([a-z-]+) -->(?:[ \t]+|$)/.exec(tail);
    const explicit = meta && Object.hasOwn(styles, meta[1]);
    const item = { indent, whitespace, explicit, marker: bullet || number,
      content: explicit ? tail.slice(meta[0].length) : tail };
    if (bullet) return { ...item, id: explicit ? meta[1] : symbols[bullet] || 'disc',
      custom: explicit || Object.hasOwn(symbols, bullet), value: 1 };
    const parens = number.startsWith('(') || number.startsWith('（');
    const value = number.slice(parens ? 1 : 0, -1).normalize('NFKC');
    if (!numerals.test(value) || (!space && /^[\da-z]/i.test(value) && !parens && !number.endsWith('、') && tail)) return null;
    const form = forms[parens ? number[0] + number.at(-1) : number.at(-1)];
    if (explicit) return { ...item, id: meta[1], custom: true, value: Number(value) || 1 };
    if (/^\d/.test(value)) return { ...item, id: 'decimal-' + form, custom: number.at(-1) !== '.', value: Number(value) };
    if (/^[a-z]/i.test(value)) {
      const letter = value.toUpperCase();
      const casing = value === letter ? 'upper' : 'lower';
      if (letter.length > 2 && !validRoman.test(letter) && !/^([A-Z])\1+$/.test(letter)) return null;
      const alpha = [...letter].reduce((result, char) => result * 26 + char.charCodeAt(0) - 64, 0);
      const roman = validRoman.test(letter) ? [...letter].reduce((result, char, i) =>
        result + romanDigits[char] * (romanDigits[char] < romanDigits[letter[i + 1]] ? -1 : 1), 0) : 0;
      return { ...item, id: casing + '-alpha' + (form === 'dot' ? '' : '-' + form),
        romanId: casing + '-roman' + (form === 'dot' ? '' : '-' + form), roman, custom: true, value: alpha };
    }
    const family = /[貳參陸萬]/.test(value) ? 'chinese-traditional' :
      /[壹贰叁肆伍陆柒捌玖拾佰仟]/.test(value) ? 'chinese-formal' : 'chinese';
    return { ...item, id: family + '-' + form, custom: true, value: chineseNumber(value) };
  }

  function scan(text, includeNative = false) {
    const lines = text.split('\n');
    let fence;
    let htmlBlock;
    const rows = lines.map((line, index) => {
      const quote = line.match(/^(?: {0,3}>[ \t]?)+/)?.[0] || '';
      const scope = quote.replace(/[ \t]/g, '');
      const body = line.slice(quote.length).replace(/\r$/, '');
      const ticks = body.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
      if (fence && fence.scope === scope) {
        if (ticks && ticks[1].startsWith(fence.ticks) && !ticks[2].trim()) fence = null;
        return { index, quote, scope, protected: true };
      }
      const rawTag = body.match(/^ {0,3}<(pre|script|style|textarea)(?=[\s>])/i)?.[1];
      if (htmlBlock || rawTag) {
        htmlBlock ||= new RegExp('</' + rawTag + '\\s*>', 'i');
        if (htmlBlock.test(body)) htmlBlock = null;
        return { index, quote, scope, protected: true };
      }
      if (ticks) {
        fence = { ticks: ticks[1], scope };
        return { index, quote, scope, protected: true };
      }
      const item = row(body);
      const itemFence = item?.content.match(/^(`{3,})(?:[^`]*)$|^(~{3,})/);
      if (itemFence) {
        fence = { ticks: itemFence[1] || itemFence[2], scope };
        return { index, quote, scope, protected: true };
      }
      return { index, quote, scope, body, item };
    });
    for (let start = 0; start < rows.length; start++) {
      const first = rows[start];
      if (!first.item || first.item.indent > 3) continue;
      const items = [first];
      let end = start + 1;
      for (; end < rows.length; end++) {
        const line = rows[end];
        if (line.protected || line.scope !== first.scope) break;
        if (line.item) items.push(line);
        else if (line.body.trim() && !/^[ \t]/.test(line.body)) break;
      }
      start = end - 1;
      if (!includeNative && !items.some(line => line.item.custom)) continue;

      // Roman markers such as I and C overlap with letters. Use the neighboring sequence.
      const romanGroups = new Map();
      for (const { item } of items) {
        if (!item.romanId) continue;
        const key = item.indent + item.romanId;
        if (!romanGroups.has(key)) romanGroups.set(key, []);
        romanGroups.get(key).push(item);
      }
      for (const group of romanGroups.values()) {
        if (group.some((item, i) => item.roman && item.roman + 1 === group[i + 1]?.roman)) {
          for (const item of group.filter(item => item.roman)) {
            item.id = item.romanId;
            item.value = item.roman;
          }
        }
      }
      // 壹 is shared by both scripts. Let the following sibling identify the form.
      const traditional = new Set(items.filter(({ item }) => item.id.startsWith('chinese-traditional'))
        .map(({ item }) => item.indent + item.id.replace('chinese-traditional', '')));
      for (const { item } of items) {
        if (item.marker.includes('壹') && traditional.has(item.indent + item.id.replace('chinese-formal', ''))) {
          item.id = item.id.replace('chinese-formal', 'chinese-traditional');
        }
      }

      const stack = [];
      const seenStyles = new Set();
      const lastByStyle = new Map(items.map(({ item, index }) => [item.indent + item.id, index]));
      let previous;
      let codeIndent = Infinity;
      for (const [offset, line] of items.entries()) {
        const item = line.item;
        const adjacent = previous?.index + 1 === line.index || items[offset + 1]?.index === line.index + 1;
        if (item.romanId && item.marker.endsWith('.') && !adjacent && !seenStyles.has(item.id) &&
            lastByStyle.get(item.indent + item.id) === line.index) continue;
        if (item.indent >= codeIndent) {
          line.protected = true;
          continue;
        }
        codeIndent = Infinity;
        while (stack.length && stack.at(-1).indent > item.indent) stack.pop();
        const last = stack.at(-1);
        const blankGap = previous && previous.index + 1 < line.index &&
          rows.slice(previous.index + 1, line.index).every(row => !row.body.trim());
        if (last && !last.custom && blankGap && item.indent >= last.indent + last.marker.length + 5) {
          codeIndent = last.indent + last.marker.length + 5;
          line.protected = true;
          continue;
        }
        if (!last || item.indent > last.indent) stack.push(item);
        else {
          const matching = stack.findLastIndex(parent => parent.indent === item.indent && parent.id === item.id);
          if (matching >= 0) stack.length = matching + 1;
          else if (!item.explicit && !last.explicit && !styles[item.id].symbol && !styles[last.id].symbol &&
            (item.value === 1 || seenStyles.has(item.id) || items[offset + 1]?.item.id === item.id) &&
            (previous.index + 1 === line.index || (blankGap && (seenStyles.has(item.id) ||
              lastByStyle.get(last.indent + last.id) > line.index)))) stack.push(item);
          stack[stack.length - 1] = item;
        }
        line.depth = stack.length - 1;
        seenStyles.add(item.id);
        line.normalIndent = stack.slice(0, -1).reduce((indent, parent) => indent + (styles[parent.id].symbol ? 2 : 3), 0);
        if (previous) {
          for (let i = previous.index + 1; i < line.index; i++) {
            const continuation = rows[i];
            const padding = continuation.body.match(/^[ \t]*/)[0].length;
            if (continuation.body.trim() && padding > previous.item.indent) {
              continuation.normalBody = ' '.repeat(previous.normalIndent + padding - previous.item.indent) + continuation.body.trimStart();
            }
          }
        }
        previous = line;
      }
    }
    return { lines, rows };
  }

  function normalize(text, nonce) {
    const { lines, rows } = scan(text);
    for (const line of rows) {
      if (line.normalBody) lines[line.index] = line.quote + line.normalBody;
      if (line.depth === undefined) continue;
      const { item } = line;
      const marker = styles[item.id].symbol ? '- ' : '1. ';
      const task = styles[item.id].symbol ? item.content.match(/^\[[ xX]\][ \t]+/)?.[0] || '' : '';
      lines[line.index] = line.quote + ' '.repeat(line.normalIndent) + marker +
        task + '<span class="' + nonce + line.index + '"></span> ' + item.content.slice(task.length);
    }
    return { source: lines.join('\n'), rows };
  }

  function restoreLists(container, nonce, rows) {
    const items = new Map();
    for (const marker of container.querySelectorAll('span[class^="' + nonce + '"]')) {
      const li = marker.closest('li');
      if (li) items.set(li, rows[Number(marker.className.slice(nonce.length))].item);
      if (marker.nextSibling?.nodeType === Node.TEXT_NODE) {
        marker.nextSibling.nodeValue = marker.nextSibling.nodeValue.replace(/^ /, '');
      }
      marker.remove();
    }
    for (const list of new Set([...items.keys()].map(li => li.parentElement))) {
      let active, previousId;
      for (const li of [...list.children]) {
        const item = items.get(li);
        if (!active || item?.id !== previousId) {
          active = list.cloneNode(false);
          if (item) {
            active.dataset.listStyle = item.id;
            if (active.tagName === 'OL') active.start = item.explicit || !item.custom ? item.value : 1;
          }
          list.before(active);
          previousId = item?.id;
        }
        active.append(li);
      }
      list.remove();
    }
  }

  function css() {
    return Object.values(styles).map(style => {
      const name = 'md-list-' + style.id;
      const counter = style.symbol ? '' : '@counter-style ' + name + ' { system: extends ' + style.css +
        '; prefix: "' + style.prefix + '"; suffix: "' + style.suffix + ' "; }\n';
      return counter + '[data-list-style="' + style.id + '"] { list-style-type: ' +
        (style.symbol ? '"' + style.symbol + ' "' : name) + '; }';
    }).join('\n');
  }

  function markerNumber(number, counterStyle) {
    if (counterStyle.endsWith('-alpha') && number > 0) {
      let letters = '';
      for (let n = number; n > 0; n = Math.floor((n - 1) / 26)) {
        letters = String.fromCharCode(65 + (n - 1) % 26) + letters;
      }
      return counterStyle === 'upper-alpha' ? letters : letters.toLowerCase();
    }
    if (counterStyle.endsWith('-roman') && number > 0 && number < 4000) {
      let roman = '';
      for (const [value, symbol] of [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
        [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]) {
        roman += symbol.repeat(Math.floor(number / value));
        number %= value;
      }
      return counterStyle === 'upper-roman' ? roman : roman.toLowerCase();
    }
    if (counterStyle.includes('-chinese-') && number >= 0 && number < 10000) {
      const informal = counterStyle === 'simp-chinese-informal';
      const digits = informal ? '零一二三四五六七八九' :
        counterStyle === 'simp-chinese-formal' ? '零壹贰叁肆伍陆柒捌玖' : '零壹貳參肆伍陸柒捌玖';
      if (!number) return digits[0];
      const units = informal ? ['', '十', '百', '千'] : ['', '拾', '佰', '仟'];
      let text = '', gap = false;
      for (let power = 3; power >= 0; power--) {
        const digit = Math.floor(number / 10 ** power) % 10;
        if (digit) {
          if (gap) text += digits[0];
          if (!(informal && number < 20 && power === 1 && digit === 1)) text += digits[digit];
          text += units[power];
          gap = false;
        } else if (text) gap = true;
      }
      return text;
    }
    return String(number);
  }

  // The image exporter clones elements and computed styles but does not keep CSS counter definitions.
  function paintImageMarkers(container) {
    for (const list of container.querySelectorAll('[data-list-style]')) {
      const style = styles[list.dataset.listStyle];
      let number = list.start;
      for (const item of list.children) {
        if (item.tagName !== 'LI') continue;
        const label = style.symbol || style.prefix + markerNumber(number++, style.css) + style.suffix;
        const marker = document.createElement('span');
        marker.textContent = label;
        marker.setAttribute('aria-hidden', 'true');
        Object.assign(marker.style, { position: 'absolute', insetInlineEnd: '100%', top: '0',
          marginInlineEnd: '0.35em', whiteSpace: 'nowrap' });
        item.style.position = 'relative';
        item.style.listStyleType = 'none';
        item.prepend(marker);
      }
    }
  }

  function sourcePrefix(id, value = 1) {
    return (styles[id].symbol ? '- ' : value + '. ') + '<!-- md-list:' + id + ' --> ';
  }

  return { styles, orderedMenu, bullets: Object.keys(bullets), font, fontHeader, validFont,
    scan, normalize, restoreLists, css, sourcePrefix, paintImageMarkers };
})();
