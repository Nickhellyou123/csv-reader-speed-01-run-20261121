// Fast drop-in for csv-reader 1.0.0 (make.fun's own reference CSV reader).
// Returns exactly {columns, rows, errors} for {text, header}, following its
// written broken-row policy. Speed comes from slicing fields out of the text
// instead of building them a character at a time, native indexOf jumps for
// quoted fields, and a whole-line split for records with no quotes or CRs.
// Rare broken cases (stray CR, doubled quotes, embedded line breaks,
// unterminated quotes, quote junk) fall back to slow helpers that mirror
// the reference step by step.

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  // Per-record state, read by the cold helpers.
  let recordLine = 1;
  let recordRow = null;

  // Reads an unquoted field starting at pos, with `value` already in it.
  // Cold path only (quote junk, unterminated-quote re-read): plain and
  // obviously correct, mirroring the reference character by character.
  function readUnquotedCold(value) {
    let added = 0;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        return { value, ended: 0, added };
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        return { value, ended: 1, added };
      }
      if (c === 13) {
        if (text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          return { value, ended: 1, added };
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos += 1;
        continue;
      }
      value += text[pos];
      added += 1;
      pos += 1;
    }
    return { value, ended: 2, added };
  }

  // Reads a quoted field whose opening quote is at pos. Cold path only:
  // the fast path in the main loop already handled plain quoted fields.
  function readQuotedSlow() {
    const open = pos;
    const openLine = line;
    let value = '';
    let seg = pos + 1;
    let p = pos + 1;
    let closed = false;
    while (p < n) {
      const c = text.charCodeAt(p);
      if (c === 34) {
        if (text.charCodeAt(p + 1) === 34) {
          value += text.slice(seg, p) + '"';
          p += 2;
          seg = p;
          continue;
        }
        value += text.slice(seg, p);
        p += 1;
        closed = true;
        break;
      }
      if (c === 13) {
        value += text.slice(seg, p) + '\n';
        line += 1;
        p += text.charCodeAt(p + 1) === 10 ? 2 : 1;
        seg = p;
        continue;
      }
      if (c === 10) line += 1;
      p += 1;
    }
    if (!closed) {
      // The quote never closes: literal character, text after it re-read
      // as unquoted, line count rewound to the opening quote's line.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquotedCold('"');
    }
    pos = p;
    if (pos >= n) return { value, ended: 2, added: 0 };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: 0, added: 0 };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: 1, added: 0 };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: 1, added: 0 };
    }
    const junk = readUnquotedCold(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    let fields;
    // Fast path: the whole record is one line with no quote and no CR,
    // so it is plain unquoted fields split on commas.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    const seg = text.slice(pos, lineEnd);
    if (seg.indexOf('"') === -1 && seg.indexOf('\r') === -1) {
      fields = seg.split(',');
      pos = nl === -1 ? n : nl + 1;
      if (nl !== -1) line += 1;
    } else {
      fields = [];
      let ended;
      let lastQuoted = false;
      do {
        let field;
        if (text.charCodeAt(pos) === 34) {
          lastQuoted = true;
          // Quoted field: find its closing quote natively.
          const q = text.indexOf('"', pos + 1);
          if (q === -1 || text.charCodeAt(q + 1) === 34) {
            const r = readQuotedSlow();
            field = r.value;
            ended = r.ended;
          } else {
            const content = text.slice(pos + 1, q);
            if (content.indexOf('\n') !== -1 || content.indexOf('\r') !== -1) {
              const r = readQuotedSlow();
              field = r.value;
              ended = r.ended;
            } else {
              field = content;
              const a = q + 1;
              if (a >= n) {
                pos = a;
                ended = 2;
              } else {
                const c = text.charCodeAt(a);
                if (c === 44) {
                  pos = a + 1;
                  ended = 0;
                } else if (c === 10) {
                  pos = a + 1;
                  line += 1;
                  ended = 1;
                } else if (c === 13 && text.charCodeAt(a + 1) === 10) {
                  pos = a + 2;
                  line += 1;
                  ended = 1;
                } else {
                  pos = a;
                  const junk = readUnquotedCold(field);
                  if (junk.added > 0) {
                    errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
                  }
                  field = junk.value;
                  ended = junk.ended;
                }
              }
            }
          }
        } else {
          lastQuoted = false;
          // Unquoted field: scan to the next comma, LF or CR, slicing
          // the field out whole. A stray CR is dropped (error recorded)
          // and the scan continues, accumulating segments.
          let fstart = pos;
          let val = '';
          let hasVal = false;
          for (;;) {
            if (pos >= n) {
              field = hasVal ? val + text.slice(fstart, pos) : text.slice(fstart, pos);
              ended = 2;
              break;
            }
            const c = text.charCodeAt(pos);
            if (c === 44) {
              field = hasVal ? val + text.slice(fstart, pos) : text.slice(fstart, pos);
              pos += 1;
              ended = 0;
              break;
            }
            if (c === 10) {
              field = hasVal ? val + text.slice(fstart, pos) : text.slice(fstart, pos);
              pos += 1;
              line += 1;
              ended = 1;
              break;
            }
            if (c === 13) {
              if (text.charCodeAt(pos + 1) === 10) {
                field = hasVal ? val + text.slice(fstart, pos) : text.slice(fstart, pos);
                pos += 2;
                line += 1;
                ended = 1;
                break;
              }
              errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
              val += text.slice(fstart, pos);
              hasVal = true;
              pos += 1;
              fstart = pos;
              continue;
            }
            pos += 1;
          }
        }
        fields.push(field);
      } while (ended === 0);

      // A line that held only stray CRs is left with no characters: no record.
      if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
