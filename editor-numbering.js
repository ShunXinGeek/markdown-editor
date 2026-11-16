const editorNumbering = (() => {
  const maxCandidates = 240;
  const kinds = { ordered: 'o', bullet: 'u' };
  const headingPrefix = /^( {0,3})(#{1,6})(?:[ \t]+|$)/;
  const savedPrefix = /^([ \t]*(?:#{1,6}|\d{1,9}[.)]|-)[ \t]+)<!-- md-number:v1:([hou]):(g[1-9]\d{0,7}):([1-9]):([a-z-]+):(\d{1,7}) --> (.*)$/;
  const namedStyles = {
    part: '篇', book: '编', chapter: '章', section: '节', article: '条', paragraph: '款', item: '项',
    'book-traditional': '編', 'section-traditional': '節', 'article-traditional': '條', 'item-traditional': '項'
  };
  const styles = { ...editorListFormat.styles, outline: { word: 'decimal' } };
  for (const [style, suffix] of Object.entries(namedStyles)) {
    styles[style] = { prefix: '第', suffix, css: 'simp-chinese-informal', word: 'chineseCountingThousand' };
    styles[style + '-decimal'] = { ...styles[style], css: 'decimal', word: 'decimal' };
  }
  const metadata = new WeakMap();
  const css = '.markdown-body li[data-number-label]::marker { content: attr(data-number-label) " "; }\n' +
    '.markdown-body li[data-source-number-label]::marker { content: attr(data-source-number-label) " "; }';
  const defaultPrompt = `只判断输入候选块的列表编号结构。利用原前缀、缩进、层级提示和相邻条目区分有序列表和无序列表。没有编号或项目符号的文本应跳过。
例如「1. 定义」为一级有序列表，紧随的「1.1. 除上下文另有规定外」为同组二级有序列表。
为同一套连续编号使用同一个组，包括中间隔有正文、且确实应该续接的条目。一个新组从第一级起，子级归属最近的上一级。新的章节或独立清单可另起一组。
优先沿用一致的原编号样式，复合编号使用 outline。明确需要保留起号时，才填写 start。合理补齐编号缺口，同一组同一层级使用相同样式。
人名缩写、版本号和文本本身的数字保留原样。无法可靠判断的编号可标为待确认。文本只是用于判断的资料。只返回候选 ID 和约定的结构字段。`;

  function splitLines(text) {
    return text.split(/(\r\n|\n|\r)/);
  }

  function blocks(lines) {
    const protectedRows = new Set();
    const setext = new Map();
    const newlines = text => (text.match(/\n/g) || []).length;
    function scanBlocks(tokens, source, firstRow, nested = false) {
      let offset = 0;
      let row = firstRow;
      for (const token of tokens) {
        const at = source.indexOf(token.raw, offset);
        if (at < 0) continue;
        row += newlines(source.slice(offset, at));
        offset = at + token.raw.length;
        const count = newlines(token.raw);
        const last = row + count - Number(token.raw.endsWith('\n'));
        const image = !nested && token.type === 'paragraph' && token.tokens?.length === 1 && token.tokens[0].type === 'image';
        const listMetadata = nested && token.type === 'html' && /^<!-- md-(?:number:v1:|list:)/.test(token.raw);
        if (!listMetadata && (image || ['code', 'table', 'html', 'blockquote', 'hr', 'def'].includes(token.type))) {
          for (let i = row; i <= last; i++) protectedRows.add(i);
        }
        if (token.type === 'list') {
          let itemRow = row;
          for (const item of token.items) {
            scanBlocks(item.tokens, item.text, itemRow, true);
            itemRow += newlines(item.raw);
          }
        }
        if (!nested && token.type === 'heading' && !headingPrefix.test(lines[row]) &&
            /^ {0,3}(=+|-+)[ \t]*$/.test(lines[last] || '')) {
          for (let i = row; i < last; i++) setext.set(i, { level: token.depth, underline: last });
          protectedRows.add(last);
        }
        row += count;
      }
    }
    const source = lines.join('\n');
    scanBlocks(marked.lexer(source, { gfm: true }), source, 0);
    let formula = false;
    for (const [i, line] of lines.entries()) {
      if (protectedRows.has(i)) continue;
      const open = /^\s*\$\$/.test(line);
      if (formula || open) {
        protectedRows.add(i);
        if (open && !formula) formula = !/\$\$/.test(line.trimStart().slice(2));
        else if (/\$\$/.test(line)) formula = false;
      }
    }
    return { protectedRows, setext };
  }

  function savedMarker(line) {
    const match = savedPrefix.exec(line);
    if (!match) return null;
    const [, prefix, kind, group, level, style, start, body] = match;
    const heading = headingPrefix.exec(line);
    const ordered = /^[ \t]*\d/.test(prefix);
    if (!validStyle(kind, style) || Number(start) < 1 ||
        (kind === 'h' ? heading?.[2].length !== Number(level) : Boolean(heading) || ordered !== (kind === 'o'))) return null;
    return { prefix, kind, group, level: Number(level), style, start: Number(start), body };
  }

  function prefixOf(text, openingLine) {
    const named = /^(第([\d０-９零〇一二三四五六七八九十百千萬万壹貳贰參叁肆伍陸陆柒捌玖拾佰仟]{1,16})([篇編编章節节條条款項项]))(?:[ \t]+|[：:、．.][ \t]*|(?=\p{L}))/u.exec(text);
    if (named) {
      const style = Object.keys(namedStyles).find(key => namedStyles[key] === named[3]);
      const digits = /^\d+$/.test(named[2].normalize('NFKC'));
      return { prefix: named[1], length: named[0].length, style: style + (digits ? '-decimal' : ''),
        value: digits ? Number(named[2].normalize('NFKC')) : editorListFormat.row(named[2] + '、 内容')?.value };
    }
    const compound = /^([\d０-９]{1,9}(?:[.．][\d０-９]{1,9}){1,8})([.．)）、]?)[ \t]+/.exec(text);
    if (compound) return { prefix: compound[1], length: compound[0].length, style: 'outline',
      value: Number(compound[1].normalize('NFKC').split('.').at(-1)), suffix: compound[2] };
    const item = editorListFormat.row(openingLine ? text.replace(/^(\d{1,9})\\\.(?=[ \t])/, '$1.') : text);
    if (!item || !item.content || !Object.hasOwn(styles, item.id)) return null;
    return { prefix: item.marker, length: text.length - item.content.length, style: item.id, value: item.value };
  }

  function listRows(text) {
    const parts = splitLines(text);
    const lines = parts.filter((_, index) => index % 2 === 0);
    const { protectedRows, setext } = blocks(lines);
    const { rows } = editorListFormat.scan(lines.join('\n'), true);
    const first = lines.findIndex(line => line.trim());
    const paragraphs = new Set();
    const candidates = lines.flatMap((line, index) => {
      const row = rows[index];
      if (protectedRows.has(index) || row.protected || !line.trim() || row.quote) return [];
      const saved = savedMarker(line);
      const heading = headingPrefix.exec(line);
      const underline = setext.get(index);
      const leading = heading?.[0].length ?? line.match(/^[ \t]*/)[0].length;
      const marker = prefixOf(line.slice(leading), index === first && !heading);
      // An isolated letter followed by a period can also be an initial in prose.
      const ambiguous = !heading && row.depth === undefined && row.item?.romanId && row.item.marker.endsWith('.');
      const mark = saved ? { prefix: saved.kind === 'h' || saved.style === 'outline' ? '' : saved.prefix.trim(),
        style: saved.style, value: saved.start, length: line.length - saved.body.length - leading } : ambiguous ? null : marker;
      if (!mark) {
        if (!heading && !underline && leading === 0) paragraphs.add(index);
        return [];
      }
      const end = leading + (mark?.length || 0);
      const body = line.slice(end);
      if (!body.trim()) return [];
      const styled = styles[mark?.style];
      const prefix = mark?.prefix || '';
      const indent = row.item?.indent ?? line.slice(0, leading).match(/^[ \t]*/)[0]
        .replace(/\t/g, '    ').length;
      const depth = saved?.level || (mark?.style === 'outline' && prefix ? prefix.normalize('NFKC').split('.').length : 0) ||
        heading?.[2].length || underline?.level || (row.depth === undefined ? 0 : row.depth + 1);
      return [{ id: index + 1, line, end, body, leading, heading, underline, mark, saved,
        native: Boolean(row.item && mark && !heading && !underline),
        hint: { id: index + 1, headingLevel: 0, indent, depth,
          kind: styled && !styled.symbol ? 'ordered' : 'bullet',
          prefix, style: mark?.style || 'disc', value: mark?.value ?? 0,
          priorGroup: saved?.group || '', priorLevel: saved?.level || 0,
          excerpt: body.split(/[`$[<]/, 1)[0].trim().replace(/https?:\/\/\S+/gi, '[URL]').slice(0, 72) } }];
    });
    return { lines, candidates, paragraphs, first };
  }

  function find(text) {
    const { lines, candidates, first } = listRows(text);
    for (const candidate of candidates) {
      const { prefix, depth } = candidate.hint;
      const reference = /^(?:第|[0-9０-９]+[.．])/.test(prefix) &&
        new RegExp('(?:参见|依照|见|根据|详见)[ \\t]*' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(text);
      candidate.review = Boolean(reference || (candidate.mark && !candidate.saved && !depth));
    }
    protectOpeningList(candidates, lines, first + 1);
    return candidates;
  }

  function protectOpeningList(candidates, lines, firstId) {
    const root = candidates[0];
    if (root?.id !== firstId || root.saved || root.hint.kind !== 'ordered' ||
        !Object.hasOwn(editorListFormat.styles, root.hint.style) ||
        (root.review && !root.hint.style.startsWith('decimal-'))) return;

    function setChoice(candidate, level, start = 0) {
      candidate.review = false;
      candidate.openingList = { id: candidate.id, kind: 'ordered', level, group: root.id,
        style: candidate.hint.style, start, review: false };
    }

    const { value } = root.hint;
    setChoice(root, 1, value > 0 && value <= 1000000 ? value : 0);
    if (root.hint.style !== 'decimal-dot') return;
    let branch = [value];
    let previousId = root.id;
    for (const candidate of candidates.slice(1)) {
      if (candidate.saved || candidate.hint.kind !== 'ordered' || candidate.hint.style !== 'outline' ||
          lines.slice(previousId, candidate.id - 1).some(line => line.trim())) break;
      const path = candidate.hint.prefix.normalize('NFKC').split('.').map(Number);
      if (path.slice(0, -1).join('.') !== branch.slice(0, path.length - 1).join('.')) break;
      setChoice(candidate, path.length);
      branch = path;
      previousId = candidate.id;
    }
  }

  function validStyle(kind, style) {
    return Object.hasOwn(styles, style) && Boolean(styles[style].symbol) === (kind === 'u');
  }

  function decisions(candidates, data, previous = []) {
    if (!Array.isArray(data?.items) || data.items.length > candidates.length) throw Error('Invalid numbering response');
    const known = new Map(candidates.map(candidate => [candidate.id, candidate]));
    const previousGroups = new Set(previous.map(item => item.group));
    const result = new Map();
    for (let choice of data.items) {
      if (!choice || !known.has(choice.id) || result.has(choice.id) ||
          Object.keys(choice).sort().join() !== 'group,id,kind,level,review,start,style' ||
          typeof choice.review !== 'boolean' || typeof choice.kind !== 'string' ||
          typeof choice.style !== 'string' || !Number.isInteger(choice.level) ||
          !Number.isInteger(choice.group) || !Number.isInteger(choice.start)) {
        throw Error('Invalid numbering decision');
      }
      const opening = known.get(choice.id).openingList;
      if (opening && (choice.kind !== opening.kind || choice.level !== opening.level ||
          choice.group !== opening.group)) choice = opening;
      let issue;
      if (choice.start < 0 || choice.start > 1000000) issue = 'numberingIssueStart';
      else if (choice.kind !== 'skip') {
        const kind = kinds[choice.kind];
        if (!Object.hasOwn(kinds, choice.kind) || choice.level < 1 || choice.level > 9) issue = 'numberingIssueLevel';
        else if (!known.has(choice.group) && !previousGroups.has(choice.group) || choice.group > choice.id) {
          issue = 'numberingIssueGroup';
        } else if (choice.group === choice.id && choice.level !== 1) issue = 'numberingIssueGroupStart';
        else if (choice.style !== 'auto' && !validStyle(kind, choice.style)) issue = 'numberingIssueStyle';
      }
      result.set(choice.id, issue ? { ...choice, issue } : choice);
    }
    for (const { id, openingList } of candidates) {
      if (openingList && !result.has(id)) result.set(id, openingList);
    }
    return result;
  }

  function pendingParent(groups, { id, group, level }, pending) {
    if (group <= 0 || group > id || level < 1 || level > 9) return;
    const parent = groups.get(group);
    if (parent && parent.level < level) return parent.id;
    if (pending) groups.set(group, { id, level });
    else groups.delete(group);
  }

  function suggestedGroup(candidate, choice, before, after, results) {
    if (!before || !after || after.issue || candidate.hint.prefix || before.group !== after.group ||
        before.kind !== after.kind || before.level !== choice.level || after.level !== choice.level) return;
    const root = results.get(before.group);
    if (!root || root.issue || root.level !== 1 || root.group !== root.id) return;
    const branch = prefix => {
      const parts = prefix.normalize('NFKC').split('.');
      return parts.length === choice.level && parts.every(part => /^\d+$/.test(part)) ? parts.slice(0, -1).join('.') : '';
    };
    const left = branch(before.prefix);
    if (!left || left !== branch(after.prefix)) return;
    return { id: choice.id, kind: before.kind, level: choice.level, group: before.group,
      style: 'auto', start: 0, review: false };
  }

  async function analyze(candidates, request, signal, batchLimit) {
    const batchSize = Number.isInteger(batchLimit) && batchLimit > 0 ? Math.min(batchLimit, maxCandidates) : maxCandidates;
    const result = new Map();
    const list = [];
    const pendingGroups = new Map();
    const firstBatchByLevel = new Map();
    const total = Math.ceil(candidates.length / batchSize);
    for (let index = 0; index < total; index++) {
      const batch = candidates.slice(index * batchSize, (index + 1) * batchSize);
      const previous = list.filter(Boolean);
      const response = await request(batch.map(candidate => candidate.hint), previous, index + 1, total);
      signal.throwIfAborted();
      const choices = decisions(batch, response, previous);
      for (const [position, candidate] of batch.entries()) {
        const choice = choices.get(candidate.id);
        if (!choice || choice.kind === 'skip' && !choice.issue) continue;
        const { id, kind, level, group } = choice;
        const blockedRoot = group !== id && result.get(group)?.issue;
        const parent = pendingParent(pendingGroups, choice, choice.issue || blockedRoot);
        if (choice.issue) {
          const next = batch[position + 1];
          const following = next && choices.get(next.id);
          const repair = choice.issue === 'numberingIssueGroupStart' && following && suggestedGroup(candidate, choice,
            list[level - 1], { ...following, prefix: next.hint.prefix }, result);
          result.set(id, repair ? { ...choice, repair } : choice);
          if (list[level - 1]?.group === group) list.length = level - 1;
          continue;
        }
        if (blockedRoot || parent) {
          result.set(id, choice);
          continue;
        }
        const key = group + ':' + level;
        if (!firstBatchByLevel.has(key)) firstBatchByLevel.set(key, index);
        // Keep the established style and start for a level continued in a later batch.
        result.set(id, firstBatchByLevel.get(key) < index ? { ...choice, style: 'auto', start: 0 } : choice);
        list.length = level;
        const { prefix, excerpt } = candidate.hint;
        list[level - 1] = { id, kind, level, group, prefix, excerpt };
      }
    }
    return result;
  }

  function template(style, level) {
    if (style === 'outline') return Array.from({ length: level }, (_, index) => '%' + (index + 1)).join('.');
    const pattern = styles[style];
    return pattern.symbol || pattern.prefix + '%' + level + pattern.suffix;
  }

  function advance(group, level, start) {
    const index = level - 1;
    if (index > group.counters.length) return false;
    group.counters[index] = (group.counters[index] ?? start - 1) + 1;
    group.counters.length = level;
    return true;
  }

  function label(style, counters) {
    if (style === 'outline') return counters.join('.');
    const pattern = styles[style];
    return pattern.symbol || pattern.prefix + editorListFormat.markerNumber(counters.at(-1), pattern.css) + pattern.suffix;
  }

  function styleExamples(style, level) {
    if (!Object.hasOwn(styles, style)) return '';
    const counters = Array(level).fill(1);
    const first = label(style, counters);
    counters[level - 1] = 2;
    const second = label(style, counters);
    return first === second ? first : first + ' · ' + second;
  }

  function reviewStyles(kind, level) {
    return Object.keys(styles).filter(style => validStyle(kinds[kind], style))
      .map(style => [style, styleExamples(style, level)]);
  }

  function patch(original, candidates, result, picks, levelStyles = new Map()) {
    const originalParts = splitLines(original);
    const parts = originalParts.slice();
    const edits = new Map();
    const preview = [];
    const names = new Set(candidates.map(candidate => candidate.saved?.group).filter(Boolean));
    const claims = new Set();
    const groups = new Map();
    const pendingGroups = new Map();
    let nextName = 1;
    for (const candidate of candidates) {
      const proposed = result.get(candidate.id);
      if (!proposed || proposed.kind === 'skip' && !proposed.issue) continue;
      const pick = picks.get(candidate.id);
      const row = { candidate, proposed, label: '', pending: false };
      preview.push(row);
      let suggestion = proposed;
      if (proposed.issue) {
        suggestion = pick === 'use' ? proposed.repair : undefined;
        if (!suggestion && pick !== 'ordered' && pick !== 'bullet') {
          pendingParent(pendingGroups, proposed, true);
          row.issue = proposed.issue;
          row.pending = pick !== 'keep';
          continue;
        }
      }
      if (pick === 'keep' || (!pick && (candidate.review || proposed.review))) {
        row.pending = !pick;
        continue;
      }
      const selection = pick && pick !== 'use' ? { kind: pick, level: 1, group: candidate.id, style: 'auto', start: 1 } : suggestion;
      if (proposed.issue) row.proposed = selection;
      const parent = pendingParent(pendingGroups, selection, false);
      if (parent) {
        row.issue = 'numberingIssueParent';
        row.issueLine = parent;
        row.pending = true;
        continue;
      }
      const kind = kinds[selection.kind];
      const { level } = selection;
      let group = groups.get(selection.group);
      if (!group && selection.group === candidate.id) {
        let name = candidate.saved?.group;
        if (!name || claims.has(name)) {
          while (names.has('g' + nextName)) nextName++;
          name = 'g' + nextName++;
        }
        claims.add(name);
        groups.set(selection.group, group = { name, levels: new Map(), counters: [] });
      }
      if (!group) {
        if (result.get(selection.group)?.issue) {
          row.issue = 'numberingIssueParent';
          row.issueLine = selection.group;
        }
        row.pending = true;
        continue;
      }
      const existing = group.levels.get(level);
      const preferred = validStyle(kind, candidate.hint.style) ? candidate.hint.style : kind === 'u' ? 'disc' : 'decimal-dot';
      const bulkStyle = selection === proposed && levelStyles.get(proposed.kind + ':' + level);
      const style = bulkStyle || (selection.style === 'auto' ? existing?.style || preferred : selection.style);
      const start = existing?.start ?? (selection.start || (candidate.saved?.start ?? 1));
      if (existing && (existing.style !== style || (selection.start && selection.start !== start)) ||
          !advance(group, level, start)) { row.pending = true; continue; }
      group.levels.set(level, { style, start });
      row.label = label(style, group.counters);
      row.style = style;
      row.level = level;
      row.anchor = selection.group;
      const prefix = ' '.repeat((level - 1) * 3) + (kind === 'u' ? '- ' : '1. ');
      const index = (candidate.id - 1) * 2;
      if (parts[index] !== candidate.line || parts[index].slice(candidate.end) !== candidate.body) {
        throw Error('Document changed during numbering');
      }
      const marker = prefix + '<!-- md-number:v1:' + [kind, group.name, level, style, start].join(':') + ' --> ';
      parts[index] = marker + candidate.body;
      edits.set(index, [candidate.end, marker.length]);
      if (candidate.underline) {
        const underlineIndex = candidate.underline.underline * 2;
        edits.set(underlineIndex, [originalParts[underlineIndex].length, 0]);
        parts[underlineIndex] = '';
      }
      row.changed = parts[index] !== candidate.line;
    }
    if (!originalParts.every((part, index) => {
      const [before, after] = edits.get(index) || [0, 0];
      return part.slice(before) === parts[index].slice(after);
    })) throw Error('Unexpected content change');
    return { text: parts.join(''), preview };
  }

  function sourceOutlines(candidates) {
    const items = new Map();
    let group;
    for (const { id, mark, hint, saved } of candidates) {
      if (saved) {
        group = undefined;
        continue;
      }
      const path = hint.style === 'outline' ? mark.prefix.normalize('NFKC').split('.').map(Number) :
        hint.style === 'decimal-dot' && hint.indent <= 3 && hint.depth <= 1 ? [mark.value] : [];
      if (!path.length || path.some(value => value < 1)) continue;
      if (/(?:^|[.．])[0０]/.test(mark.prefix)) continue;
      const level = path.length - 1;
      const suffix = level ? mark.suffix : mark.prefix.at(-1);
      const separators = mark.prefix.match(/[.．]/g) || [];
      const text = path.map((_, index) => '%' + (index + 1) + (index < level ? separators[index] : suffix)).join('');
      if (!level && (!group || path[0] !== group.counters[0] + 1 || text !== group.levels[0].text)) {
        group = { id, counters: [], levels: [] };
      }
      const value = path[level];
      if (!group || path.slice(0, -1).some((parent, index) => parent !== group.counters[index])) continue;
      const definition = group.levels[level] || { start: level ? 1 : value, text };
      if (definition.text !== text || value !== (group.counters[level] ?? definition.start - 1) + 1) continue;
      group.levels[level] = definition;
      group.counters[level] = value;
      group.counters.length = path.length;
      items.set(id, { group, level, label: path.map((part, index) =>
        String(part) + (index < level ? separators[index] : suffix)).join('') });
    }
    return items;
  }

  function annotate(source, nonce) {
    const rows = new Map();
    const { lines, candidates, paragraphs } = listRows(source);
    const outlines = sourceOutlines(candidates);
    const listLines = new Set(candidates.map(candidate => candidate.id - 1));
    for (const index of paragraphs) {
      if (listLines.has(index - 1)) lines[index] = '\n' + lines[index];
      if (listLines.has(index + 1)) lines[index] += '\n';
    }
    const indents = [];
    let previous = 0;
    for (const { id, line, body, leading, end, heading, underline, native, hint, saved } of candidates) {
      const index = id - 1;
      for (let i = previous; i < index; i++) {
        if (paragraphs.has(i)) indents.length = 0;
      }
      previous = id;
      const outline = outlines.get(id);
      const numbered = outline?.group.levels.length > 1;
      const inferred = heading || underline || numbered || (!native && hint.style === 'outline');
      const depth = Math.min(Math.max(0, hint.depth - 1), indents.length);
      const indent = inferred ? (depth ? indents[depth - 1] + 3 : 0) : hint.indent;
      if (hint.depth) {
        indents.length = depth + 1;
        indents[depth] = indent;
      } else if (!indent) indents.splice(0, indents.length, 0);
      if (!saved && native && !numbered) continue;
      if (underline) lines[underline.underline] = '';
      const style = Object.hasOwn(editorListFormat.styles, hint.style) ? hint.style : 'decimal-dot';
      const rawLabel = !saved && hint.kind === 'ordered' ? line.slice(leading, end).trimEnd() : '';
      if (saved || rawLabel) rows.set(index, saved || (numbered ? { outline } :
        { rawLabel, reviewLine: hint.style === 'outline' ? id : undefined }));
      const span = rows.has(index) ? '<span class="' + nonce + index + '"></span> ' : '';
      const task = hint.kind === 'bullet' ? body.match(/^\[[ xX]\][ \t]+/)?.[0] || '' : '';
      const prefix = saved && saved.kind !== 'h' ? saved.prefix :
        ' '.repeat(indent) + (hint.kind === 'bullet' ? '- ' : '1. ');
      lines[index] = prefix + '<!-- md-list:' + style + ' --> ' + task + span + body.slice(task.length);
    }
    return { source: lines.join('\n'), rows };
  }

  function decorate(container, nonce, rows) {
    if (!rows.size) return;
    const groups = new Map();
    for (const span of container.querySelectorAll('span[class^="' + nonce + '"]')) {
      const index = Number(span.className.slice(nonce.length));
      const info = rows.get(index);
      if (!info) continue;
      const node = span.closest('li');
      if (span.nextSibling?.nodeType === Node.TEXT_NODE) {
        span.nextSibling.nodeValue = span.nextSibling.nodeValue.replace(/^ /, '');
      }
      span.remove();
      if (!node || metadata.has(node)) continue;
      if (info.outline) {
        const { group, level, label } = info.outline;
        metadata.set(node, { groupId: 'source-list-' + group.id, level, format: 'decimal', ...group.levels[level] });
        node.dataset.numberLabel = label;
        node.dataset.sourceOutline = '';
        continue;
      }
      if (info.rawLabel) {
        node.dataset.sourceNumberLabel = info.rawLabel;
        if (info.reviewLine) node.dataset.numberReviewLine = info.reviewLine;
        continue;
      }
      const groupId = (info.kind === 'h' ? 'heading-' : 'list-') + info.group;
      if (!groups.has(groupId)) groups.set(groupId, { levels: new Map(), counters: [] });
      const group = groups.get(groupId);
      const existing = group.levels.get(info.level);
      if (existing && (existing.style !== info.style || existing.start !== info.start) ||
          !advance(group, info.level, info.start)) continue;
      group.levels.set(info.level, info);
      metadata.set(node, { groupId, level: info.level - 1, start: info.start, format: styles[info.style].word,
        text: template(info.style, info.level) });
      node.dataset.numberLabel = label(info.style, group.counters);
    }
  }

  return { defaultPrompt, css, find, decisions, analyze, patch, annotate, decorate, reviewStyles, styleExamples,
    info: node => metadata.get(node) };
})();
