(() => {
  const $ = (s) => document.querySelector(s);
  const canvas = $("#canvas");
  const world = $("#world");     // the current level's space, laid out in screen pixels

  // Chrome is in screen pixels and never scales; only positions and sizes do.
  const HEAD = 44;          // header height of a box
  const INSET = 8;          // body margin inside a box
  const GAP = 12;           // spacing between stacked boxes
  const NEW_W = 60;         // width of a new box on screen, before its text widens it
  const NOTE_FONT = 14;     // font size of a new box's text on screen
  const MIN_PX = 24;        // smallest a box may be resized to on screen
  // Level of detail by on-screen size: full box, title only, or a bare tile.
  const FULL_W = 120, FULL_H = 92;
  const TITLE_W = 56, TITLE_H = 26;
  const BARE_W = 40, BARE_H = 32;   // a box without a title bar shows its body down to this
  const COLORS = 6;
  const SPACE = { w: 1600, h: 1000 };   // the finite top-level space
  const BOX_SPACE = { w: 1, h: 1 };     // every box's own space: its children are fractions of it
  const FORMAT = 2;                     // 1: a box's space was as many units as the box itself
  const OPEN_MS = 420;

  const ICON = {
    check: '<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg>',
    add: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>',
    open: '<svg viewBox="0 0 16 16"><path d="M6 3H3v10h10v-3M9 3h4v4M13 3L7.5 8.5"/></svg>',
    del: '<svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>',
    menu: '<svg viewBox="0 0 16 16" class="dots"><circle cx="3.5" cy="8" r="1.35"/><circle cx="8" cy="8" r="1.35"/><circle cx="12.5" cy="8" r="1.35"/></svg>',
    color: '<svg viewBox="0 0 16 16"><path d="M8 2.5c2.5 3 4 5 4 7a4 4 0 0 1-8 0c0-2 1.5-4 4-7z"/></svg>',
    grip: '<svg viewBox="0 0 10 10"><path d="M9 3L3 9M9 7L7 9"/></svg>',
  };
  // Corners resize both ways; sides only along their own axis.
  const RESIZE_HANDLES = ["n", "s", "e", "w", "nw", "ne", "sw", "se"]
    .map((d) => `<div class="resize ${d}" data-dir="${d}" title="Resize">${d === "se" ? ICON.grip : ""}</div>`)
    .join("");

  let state = { boxes: {}, seq: 0 };
  let focus = null;           // id of the box we've opened, null = top level
  let selected = null;
  let drag = null;
  let kx = 1, ky = 1;         // screen pixels per unit of the current level's space
  let anim = null;            // running open/close transition
  let noteEdit = null;        // the text being edited in place: { t, w, snapped }
  let titling = null;         // a box given an empty title bar to type its first title into
  const undoStack = [];

  // ---------- model helpers ----------

  const uid = () => Math.random().toString(36).slice(2, 10);
  const kids = (pid) =>
    Object.values(state.boxes).filter((b) => b.parent === pid).sort((a, b) => (a.z || 0) - (b.z || 0));
  const maxZ = () => Object.values(state.boxes).reduce((m, b) => Math.max(m, b.z || 0), 0);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // Display options; boxes saved before they existed keep the old look.
  const isActionable = (b) => b.actionable !== false;
  // A box shows a title bar exactly when it has a title, or while one is being typed.
  const hasTitle = (b) => !!b.title || b.id === titling;
  const headOf = (b) => (hasTitle(b) ? HEAD : INSET);   // space above a box's body
  // A box shows its text unless it holds boxes; one holding both shows its boxes
  // unless set to prefer its text.
  const showsText = (b) => !kids(b.id).length || (!!b.text && !!b.preferText);

  function snapshot() {
    undoStack.push(JSON.stringify(state));
    if (undoStack.length > 100) undoStack.shift();
  }

  function undo() {
    const s = undoStack.pop();
    if (!s) return;
    state = JSON.parse(s);
    if (focus && !state.boxes[focus]) focus = null;
    if (selected && !state.boxes[selected]) selected = null;
    render();
    save();
  }

  // Every box is its own space of the same size, however big it is, so positions
  // stay just as precise however deep the boxes nest. Nothing is rounded: that
  // would snap children to a grid that gets coarser the smaller their parent.
  const innerOf = (pid) => (pid && state.boxes[pid] ? BOX_SPACE : state.space);

  // Keep a child fully inside its parent by moving it and, if needed, shrinking it.
  function fitInside(b) {
    const inner = innerOf(b.parent);
    b.w = clamp(b.w || 0, inner.w * 1e-9, inner.w);
    b.h = clamp(b.h || 0, inner.h * 1e-9, inner.h);
    b.x = clamp(b.x || 0, 0, inner.w - b.w);
    b.y = clamp(b.y || 0, 0, inner.h - b.h);
  }

  // The element a level's children are drawn into, and its pixels-per-unit.
  function containerOf(pid) {
    if (pid === focus) return world;
    return boxEl(pid)?.querySelector(":scope > .body") || null;
  }

  function scaleOf(pid) {
    const inner = innerOf(pid);
    const r = containerOf(pid)?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return { sx: kx, sy: ky };
    return { sx: r.width / inner.w, sy: r.height / inner.h };
  }

  // `x, y` is the top-left corner in the parent's units, or its center when `centered`.
  function createBox(parent, x, y, centered = false) {
    snapshot();
    const p = parent && state.boxes[parent];
    const { sx, sy } = scaleOf(parent);
    // A new box is one line of text at NOTE_FONT; typing grows it from there.
    const w = NEW_W / sx, h = (NOTE_FONT * NOTE_LH + NOTE_PAD * 2 + INSET * 2) / sy;
    const b = {
      id: uid(),
      parent,
      x: centered ? x - w / 2 : x,
      y: centered ? y - h / 2 : y,
      w,
      h,
      title: "",
      text: "",
      done: false,
      color: p ? (p.color + 1) % COLORS : state.seq++ % COLORS,
      z: maxZ() + 1,
    };
    state.boxes[b.id] = b;
    fitInside(b);
    selected = b.id;
    render();
    startEdit(b.id);
    if (noteEdit) {
      noteEdit.snapped = true;   // creating the box is the undo step
      growNote(noteEdit.t);      // wide enough for its placeholder
    }
    save();
    return b;
  }

  // Next free slot inside a parent: stacked below existing children.
  function nextSlot(pid) {
    const { sx, sy } = scaleOf(pid);
    const y = kids(pid).reduce((m, c) => Math.max(m, c.y + c.h + GAP / sy), GAP / sy);
    return { x: GAP / sx, y };
  }

  function addChild(pid) {
    const { x, y } = nextSlot(pid);
    createBox(pid, x, y);
  }

  function descendants(id) {
    return kids(id).flatMap((c) => [c.id, ...descendants(c.id)]);
  }

  function remove(id) {
    const b = state.boxes[id];
    if (!b) return;
    const all = descendants(id);
    if (all.length && !confirm(`Delete “${b.title || "Untitled"}” and the ${all.length} box${all.length > 1 ? "es" : ""} inside it?`)) return;
    snapshot();
    for (const d of [id, ...all]) delete state.boxes[d];
    if (selected === id) selected = null;
    render();
    save();
  }

  function toggleDone(id) {
    snapshot();
    state.boxes[id].done = !state.boxes[id].done;
    render();
    save();
  }

  // ---------- rendering ----------

  function setRect(el, r) {
    el.style.left = r.x + "px";
    el.style.top = r.y + "px";
    el.style.width = r.w + "px";
    el.style.height = r.h + "px";
  }

  function buildBox(b) {
    const el = document.createElement("div");
    const titled = hasTitle(b), asText = showsText(b);
    el.className = `box c${b.color}${isActionable(b) && b.done ? " done" : ""}${titled ? "" : " no-title"}` +
      `${asText ? " show-text" : ""}${asText && b.text ? " has-text" : ""}${b.id === selected ? " selected" : ""}`;
    el.dataset.id = b.id;
    el.style.zIndex = b.z || 0;

    const children = kids(b.id);
    const tasks = children.filter(isActionable);
    const done = tasks.filter((c) => c.done).length;
    const count = tasks.length
      ? `<span class="count${done === tasks.length ? " all" : ""}">${done}/${tasks.length}</span>`
      : "";
    const menu = `<button class="menu-btn" data-act="menu" title="Options">${ICON.menu}</button>`;
    const check = isActionable(b) ? `<button class="check" data-act="check" title="Mark done">${ICON.check}</button>` : "";

    el.innerHTML = `
      ${titled ? `<div class="head">${check}<div class="title" spellcheck="false"></div>${count}${menu}</div>` : check + menu}
      <div class="body${asText ? " note" : ""}"></div>
      ${RESIZE_HANDLES}`;
    if (titled) el.querySelector(":scope > .head > .title").textContent = b.title;
    const body = el.querySelector(":scope > .body");
    if (asText) {
      const t = Object.assign(document.createElement("div"), { className: "note-text" });
      setNoteText(t, b.text || "");
      body.append(t, Object.assign(document.createElement("div"), { className: "note-bar", innerHTML: "<span></span>" }));
    }
    else for (const c of children) body.appendChild(buildBox(c));
    return el;
  }

  // A box's text is sized by its line count alone: its lines always fill the
  // body's height exactly, and run off the right edge rather than wrap.
  const NOTE_PAD = 6, NOTE_LH = 1.25;

  // A trailing newline only shows as an empty last line when another follows it,
  // so the page holds one extra newline at the end, the way an editor keeps it.
  function setNoteText(t, text) {
    t.textContent = text.endsWith("\n") ? text + "\n" : text;
  }

  // The text as written. While editing, the browser may keep line breaks as <br>s
  // or blocks rather than "\n"s, and textContent drops those, so walk the nodes.
  // The one break that ends the page is the one that never shows; drop it.
  const BLOCK = /^(DIV|P|LI|PRE|BLOCKQUOTE|H[1-6])$/;
  function noteText(t) {
    let s = "";
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === Node.TEXT_NODE) s += c.data;
        else if (c.nodeName === "BR") s += "\n";
        else if (c.nodeType === Node.ELEMENT_NODE) {
          const block = BLOCK.test(c.nodeName);
          if (block && s && !s.endsWith("\n")) s += "\n";
          walk(c);
          if (block && !s.endsWith("\n")) s += "\n";
        }
      }
    };
    walk(t);
    return s.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  }

  // How many lines the text shows. Outside editing the page is exactly what
  // setNoteText wrote, so the text says it. While editing the browser owns the
  // page, so measure: lay it out at a known line height and count the lines.
  const textLines = (text) => text.split("\n").length;
  function noteLines(t) {
    const text = noteText(t);
    if (!t.isContentEditable) return text ? textLines(text) : 1;   // empty: one line for its placeholder
    const st = t.style, was = [st.lineHeight, st.fontSize, st.bottom, st.height];
    Object.assign(st, { lineHeight: "40px", fontSize: "10px", bottom: "auto", height: "auto" });
    const h = t.offsetHeight - NOTE_PAD * 2;
    [st.lineHeight, st.fontSize, st.bottom, st.height] = was;
    return h > 0 ? Math.max(1, Math.round(h / 40)) : textLines(text);
  }

  function fitNote(t) {
    if (!t) return;
    const bodyH = t.parentElement.getBoundingClientRect().height;
    const lineH = Math.max(1, bodyH - NOTE_PAD * 2) / noteLines(t);
    t.style.lineHeight = lineH + "px";
    t.style.fontSize = lineH / NOTE_LH + "px";
    updateNoteBar(t);
  }

  // The width of the text's longest line, padding included.
  function noteWidth(t) {
    const st = t.style, was = [st.right, st.width];
    Object.assign(st, { right: "auto", width: "max-content" });
    const w = t.offsetWidth;
    [st.right, st.width] = was;
    return w;
  }

  // Typing grows the box to fit its text instead of shrinking the font: as tall as
  // its lines at the current line height, and as wide as its longest line, never
  // narrower than when editing began. Only resizing the box changes the font.
  const NOTE_END = 28;   // room after the longest line for the fade and the caret
  function growNote(t) {
    const el = t.closest(".box"), b = el && state.boxes[el.dataset.id];
    if (!b || noteEdit?.t !== t) return;
    if (!noteEdit.snapped) {
      snapshot();
      noteEdit.snapped = true;
    }
    const lineH = parseFloat(t.style.lineHeight) || NOTE_FONT * NOTE_LH;
    const { sx, sy } = scaleOf(b.parent);
    b.w = Math.max(noteEdit.w, (noteWidth(t) + INSET * 2 + NOTE_END) / sx);
    b.h = (noteLines(t) * lineH + NOTE_PAD * 2 + headOf(b) + INSET) / sy;
    fitInside(b);
    layoutChild(el, sx, sy);
  }

  // Lines that run off the right are scrolled with an overlay bar, drawn over
  // the text's bottom edge so it never takes height from the lines.
  function updateNoteBar(t) {
    const bar = t.nextElementSibling;
    if (!bar?.classList.contains("note-bar")) return;
    const over = t.scrollWidth - t.clientWidth;
    bar.classList.toggle("on", t.isContentEditable && over > 1);
    if (over <= 1) return;
    const track = bar.clientWidth, thumb = Math.max(24, (track * t.clientWidth) / t.scrollWidth);
    bar.firstElementChild.style.width = thumb + "px";
    bar.firstElementChild.style.transform = `translateX(${(t.scrollLeft / over) * (track - thumb)}px)`;
  }

  canvas.addEventListener("scroll", (e) => {
    if (e.target.classList?.contains("note-text")) updateNoteBar(e.target);
  }, true);

  // Size a box's insides for its on-screen size `w × h`: pick its level of detail,
  // then map its space onto its body and lay out its children there.

  function layoutBox(el, b, w, h) {
    const lod = !hasTitle(b)
      ? (w >= BARE_W && h >= BARE_H ? "full" : "bare")
      : w >= FULL_W && h >= FULL_H ? "full" : w >= TITLE_W && h >= TITLE_H ? "title" : "bare";
    if (el.dataset.lod !== lod) {
      el.classList.remove("lod-full", "lod-title", "lod-bare");
      el.classList.add("lod-" + lod);
      el.dataset.lod = lod;
    }
    if (lod !== "full") return;
    if (showsText(b)) return fitNote(el.querySelector(":scope > .body > .note-text"));
    const inner = innerOf(b.id);
    const sx = (w - INSET * 2) / inner.w, sy = (h - headOf(b) - INSET) / inner.h;
    for (const c of el.querySelectorAll(":scope > .body > .box")) layoutChild(c, sx, sy);
  }

  function layoutChild(el, sx, sy) {
    const c = state.boxes[el.dataset.id];
    const r = { x: c.x * sx, y: c.y * sy, w: c.w * sx, h: c.h * sy };
    setRect(el, r);
    layoutBox(el, c, r.w, r.h);
  }

  // Where a level's space sits on screen: filling the canvas, stretched to it like
  // a box's body is. An opened box keeps room for its rim.
  function fitRect(id = focus) {
    const { w, h } = innerOf(id);
    const m = id ? INSET : 0;
    const fw = Math.max(1, canvas.clientWidth - m * 2), fh = Math.max(1, canvas.clientHeight - m * 2);
    return { x: m, y: m, w: fw, h: fh, sx: fw / w, sy: fh / h };
  }

  function layoutLevel() {
    const f = fitRect();
    kx = f.sx;
    ky = f.sy;
    setRect(world, f);
    for (const el of world.querySelectorAll(":scope > .box")) layoutChild(el, kx, ky);
  }

  function render() {
    stopAnim();
    const top = kids(focus);
    world.className = focus ? `world frame c${state.boxes[focus].color}` : "world frame board";
    world.replaceChildren(...top.map(buildBox));
    layoutLevel();
    $("#empty").hidden = top.length > 0;
    $("#empty .empty-sub").textContent = focus
      ? "Double-click anywhere to add a box inside"
      : "Double-click anywhere to drop a box";
    renderTitle();
    renderNotes();
    if (menuFor) renderMenu();
  }

  // The side panel's headline names the open box and edits its title; the top
  // level is just "Space" and can't be renamed. A box whose title is hidden reads
  // as untitled, and naming it here shows its title, clearing it hides it.
  const spaceTitle = $("#spaceTitle");
  let titleFor = null;   // the box whose title the headline is editing
  const shownTitle = (b) => b?.title || "";

  function renderTitle() {
    const name = focus ? shownTitle(state.boxes[focus]) || "Untitled" : "Space";
    document.title = focus ? `${name} · Space` : "Space";
    if (document.activeElement === spaceTitle) return;
    spaceTitle.textContent = focus ? shownTitle(state.boxes[focus]) : "Space";
    spaceTitle.classList.toggle("editable", !!focus);
    if (!focus) spaceTitle.contentEditable = "false";
    else {
      try { spaceTitle.contentEditable = "plaintext-only"; } catch {}
      if (spaceTitle.contentEditable !== "plaintext-only") spaceTitle.contentEditable = "true";
    }
  }

  spaceTitle.addEventListener("focus", () => (titleFor = focus));
  spaceTitle.addEventListener("blur", () => {
    const b = state.boxes[titleFor];
    titleFor = null;
    const title = spaceTitle.textContent.replace(/\s+/g, " ").trim();
    if (b && shownTitle(b) !== title) {
      snapshot();
      b.title = title;
      save();
    }
    render();
  });
  spaceTitle.addEventListener("keydown", (e) => {
    if (e.key === "Escape") spaceTitle.textContent = shownTitle(state.boxes[titleFor]);
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      spaceTitle.blur();
    }
  });

  function select(id) {
    selected = id;
    for (const el of world.querySelectorAll(".box.selected")) el.classList.remove("selected");
    if (id) boxEl(id)?.classList.add("selected");
  }

  const boxEl = (id) => world.querySelector(`.box[data-id="${id}"]`);

  new ResizeObserver(() => { if (!anim) layoutLevel(); }).observe(canvas);

  // ---------- opening and closing boxes ----------

  // A rect in the world's coordinates, from a client rect.
  function worldRect(r) {
    const w = world.getBoundingClientRect();
    return { x: r.left - w.left, y: r.top - w.top, w: r.width, h: r.height };
  }

  // The rect, in the world's coordinates, where box `id` would sit with its body
  // exactly covering the screen area its own space gets once opened.
  function openedRect(id) {
    const f = fitRect(id), c = canvas.getBoundingClientRect(), w = world.getBoundingClientRect();
    const dx = c.left + canvas.clientLeft - w.left, dy = c.top + canvas.clientTop - w.top;
    const head = headOf(state.boxes[id]);
    return { x: f.x + dx - INSET, y: f.y + dy - head, w: f.w + INSET * 2, h: f.h + head + INSET };
  }

  // Pull a box out of its parent into the world layer so it can grow unclipped.
  function liftTo(el, r) {
    world.appendChild(el);
    el.style.zIndex = 1e6;
    setRect(el, r);
  }

  const ease = (t) => 1 - Math.pow(1 - t, 3);

  // Grow or shrink box `id` between two rects, re-laying out its contents every
  // frame so headers and titles stay their real size the whole way.
  function morph(el, from, to, done) {
    const b = state.boxes[el.dataset.id];
    const t0 = performance.now();
    canvas.classList.add("morphing");
    const step = (now) => {
      const t = Math.min(1, (now - t0) / OPEN_MS), e = ease(t);
      const r = {
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        w: from.w + (to.w - from.w) * e,
        h: from.h + (to.h - from.h) * e,
      };
      setRect(el, r);
      layoutBox(el, b, r.w, r.h);
      if (t < 1) anim = { frame: requestAnimationFrame(step), done };
      else {
        stopAnim();
        done();
      }
    };
    anim = { frame: requestAnimationFrame(step), done };
  }

  function stopAnim() {
    if (anim) cancelAnimationFrame(anim.frame);
    anim = null;
    if (!canvas.matches(".opening, .closing")) return canvas.classList.remove("morphing");
    // Drop the fades without animating them back, so the level that replaces
    // the morphed box appears exactly as the box looked.
    canvas.classList.add("snap");
    canvas.classList.remove("morphing", "opening", "closing");
    canvas.offsetWidth;
    canvas.classList.remove("snap");
  }

  function enter(id) {
    const target = id && state.boxes[id] ? id : "";
    if (location.hash.slice(1) !== target) location.hash = target;
    else syncFromHash();
  }

  // Is `id` somewhere inside `anc` (null = the top-level space)?
  function isInside(id, anc) {
    for (let p = state.boxes[id]?.parent ?? null; ; p = state.boxes[p]?.parent ?? null) {
      if (p === anc) return true;
      if (p === null) return false;
    }
  }

  function syncFromHash() {
    const id = decodeURIComponent(location.hash.slice(1));
    const next = id && state.boxes[id] ? id : null;
    const prev = focus;
    stopAnim();
    closeMenu();
    selected = null;
    document.activeElement?.blur?.();

    const el = next && next !== prev && isInside(next, prev) && boxEl(next);
    if (el && el.offsetWidth) {
      // Opening: the box grows out of its parent until it fills the screen.
      const from = worldRect(el.getBoundingClientRect());
      el.classList.remove("selected");
      liftTo(el, from);
      el.classList.add("lifted");
      canvas.classList.add("opening");
      morph(el, from, openedRect(next), () => {
        focus = next;
        render();
      });
      return;
    }

    focus = next;
    render();
    const back = prev && prev !== next && isInside(prev, next) && boxEl(prev);
    if (back && back.offsetWidth) {
      // Closing: the box shrinks from full screen back into its place.
      const to = worldRect(back.getBoundingClientRect());
      liftTo(back, openedRect(prev));
      back.classList.add("lifted");
      canvas.classList.add("closing");
      world.getBoundingClientRect();
      canvas.classList.remove("closing");
      morph(back, openedRect(prev), to, render);
    }
  }

  window.addEventListener("hashchange", syncFromHash);

  // ---------- title editing ----------

  function startEdit(id) {
    if (!hasTitle(state.boxes[id])) return showsText(state.boxes[id]) && startNoteEdit(id);
    const t = boxEl(id)?.querySelector(":scope > .head > .title");
    if (!t || !t.offsetWidth) {
      if (titling === id) (titling = null), render();
      return;
    }
    t.contentEditable = "true";
    t.focus();
    const r = document.createRange();
    r.selectNodeContents(t);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  // ---------- text editing in place ----------

  // A box shown as text is edited right where it sits, caret at the click (or the end).
  function startNoteEdit(id, x, y) {
    const t = boxEl(id)?.querySelector(":scope > .body > .note-text");
    if (!t || !t.offsetWidth) return;
    try { t.contentEditable = "plaintext-only"; } catch {}
    if (t.contentEditable !== "plaintext-only") t.contentEditable = "true";
    noteEdit = { t, w: state.boxes[id].w, snapped: false };
    t.focus();
    if (x == null) {
      const r = document.createRange();
      r.selectNodeContents(t);
      r.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      return;
    }
    const at = document.caretPositionFromPoint?.(x, y);
    const r = at ? document.createRange() : document.caretRangeFromPoint?.(x, y);
    if (at) r.setStart(at.offsetNode, at.offset);
    if (!r || !t.contains(r.startContainer)) return;
    r.collapse(true);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  canvas.addEventListener("input", (e) => {
    const t = e.target;
    if (t.classList?.contains("note-text")) growNote(t);
  });
  canvas.addEventListener("keyup", (e) => {
    if (e.target.classList?.contains("note-text")) updateNoteBar(e.target);
  });

  // Dragging the bar's thumb scrolls the text; pressing the track jumps there.
  // Neither takes focus, so the text stays in editing.
  canvas.addEventListener("pointerdown", (e) => {
    const bar = e.target.closest(".note-bar.on");
    if (!bar) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const t = bar.previousElementSibling, thumb = bar.firstElementChild;
    const track = bar.getBoundingClientRect(), tw = thumb.offsetWidth;
    const over = t.scrollWidth - t.clientWidth;
    const k = over / Math.max(1, track.width - tw);
    if (e.target !== thumb) t.scrollLeft = (e.clientX - track.left - tw / 2) * k;
    const x0 = e.clientX, s0 = t.scrollLeft;
    const move = (ev) => (t.scrollLeft = s0 + (ev.clientX - x0) * k);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, true);

  function endNoteEdit(t) {
    t.contentEditable = "false";
    t.scrollLeft = 0;
    const b = state.boxes[t.closest(".box").dataset.id];
    const text = noteText(t).trim() ? noteText(t) : "";
    setNoteText(t, text);
    const typed = noteEdit?.t === t && noteEdit.snapped;
    // Trimming may have dropped lines, so fit the box to what's kept.
    if (typed) growNote(t);
    else fitNote(t);
    if (noteEdit?.t === t) noteEdit = null;
    const changed = b && (b.text || "") !== text;
    if (changed) {
      if (!typed) snapshot();
      b.text = text;
      if (!text && kids(b.id).length) render();   // nothing left to show over its boxes
    }
    if (typed || changed) save();
  }

  canvas.addEventListener("focusout", (e) => {
    const t = e.target;
    if (t.classList?.contains("note-text")) return endNoteEdit(t);
    if (!t.classList?.contains("title")) return;
    t.contentEditable = "false";
    t.scrollLeft = 0;
    const b = state.boxes[t.closest(".box").dataset.id];
    const title = t.textContent.replace(/\s+/g, " ").trim();
    t.textContent = title;
    const wasTitling = titling;
    titling = null;
    if (b && b.title !== title) {
      if (wasTitling !== b.id) snapshot();   // the menu took the snapshot for a new title
      b.title = title;
      save();
    }
    if (!title) render();   // an empty title takes its bar with it
    else renderTitle();
  });

  canvas.addEventListener("keydown", (e) => {
    if (e.target.classList?.contains("note-text") && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      return e.target.blur();
    }
    if (!e.target.classList?.contains("title")) return;
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      e.target.blur();
    }
  });

  // ---------- pointer interaction ----------

  // A point on screen, in units of the current level's space.
  function toUnits(clientX, clientY) {
    const r = world.getBoundingClientRect();
    return { x: (clientX - r.left) / kx, y: (clientY - r.top) / ky };
  }

  // What would receive a drop at this point: a box or the current level, hit by
  // the dragged box's center. `r` is where the pointer alone would put the box
  // (world coordinates), so the target follows the pointer even while the shown
  // box is held inside a parent.
  function dropTargetAt(r) {
    const w = world.getBoundingClientRect();
    const hit = document.elementFromPoint(w.left + r.x + r.w / 2, w.top + r.y + r.h / 2);
    // A box showing its text hides its children, so nothing can be dropped into it;
    // a box with no text yet takes the drop and shows its boxes from then on.
    const box = hit && canvas.contains(hit) && !hit.closest(".toolbar") && hit.closest(".box.lod-full:not(.has-text)");
    if (box) return { el: box, id: box.dataset.id };
    // Anywhere else (the bare level, the toolbar, past the canvas edge, out of the
    // window) holds the box in the current level.
    return { el: null, id: focus };
  }

  function highlight(d, target) {
    if (d.target?.el === target?.el) return;
    d.target?.el?.classList.remove("drop-target");
    if (target?.el && target.id !== d.b.parent) target.el.classList.add("drop-target");
    d.target = target;
  }

  // The rect (world coordinates) a box at `r` ends up with once dropped into `pid`,
  // matching what fitInside does to it.
  function confineTo(r, pid) {
    const c = worldRect(containerOf(pid).getBoundingClientRect());
    const w = Math.min(r.w, c.w), h = Math.min(r.h, c.h);
    return { x: clamp(r.x, c.x, c.x + c.w - w), y: clamp(r.y, c.y, c.y + c.h - h), w, h };
  }

  // Drops keep the box's on-screen position and size, re-expressed in the new parent's units.
  function drop(d) {
    const { b, target } = d;
    d.target?.el?.classList.remove("drop-target");
    const r = d.el.getBoundingClientRect();
    const c = containerOf(target.id).getBoundingClientRect();
    b.parent = target.id;
    const { sx, sy } = scaleOf(b.parent);
    b.x = (r.left - c.left) / sx;
    b.y = (r.top - c.top) / sy;
    b.w = r.width / sx;
    b.h = r.height / sy;
    const p = state.boxes[b.parent];
    if (p && p.color === b.color) b.color = (p.color + 1) % COLORS;
    fitInside(b);
    render();
    save();
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || anim) return;
    const t = e.target;
    if (t.isContentEditable || t.closest(".toolbar")) return;
    const el = t.closest(".box");

    if (!el) {
      drag = { mode: "bg", sx: e.clientX, sy: e.clientY };
      return;
    }
    if (t.closest("button")) return;

    const b = state.boxes[el.dataset.id];
    document.activeElement?.blur?.();
    select(b.id);
    b.z = maxZ() + 1;
    el.style.zIndex = b.z;

    const onNote = el.classList.contains("lod-full") && !!t.closest(".note-text");
    const base = { b, el, sx: e.clientX, sy: e.clientY, scale: scaleOf(b.parent), onNote };
    const handle = t.closest(".resize");
    if (handle) {
      // Everything inside is placed in fractions of the box, so it scales along.
      drag = { ...base, mode: "resize", dir: handle.dataset.dir, ox: b.x, oy: b.y, ow: b.w, oh: b.h };
    }
    else if (t.closest(".head") || !el.classList.contains("lod-full") || !hasTitle(b))
      drag = { ...base, mode: "move", onTitle: !!t.closest(".title") };
    else drag = { ...base, mode: "click" };
    e.preventDefault();
  });

  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const rdx = e.clientX - drag.sx, rdy = e.clientY - drag.sy;
    if (!drag.moved) {
      if (Math.hypot(rdx, rdy) < 3) return;
      drag.moved = true;
      if (drag.mode === "move" || drag.mode === "resize") {
        snapshot();
        drag.el.classList.add("lifting");
        if (drag.mode === "move") {
          drag.from = worldRect(drag.el.getBoundingClientRect());
          liftTo(drag.el, drag.from);
        }
      }
    }
    const { b } = drag;
    if (drag.mode === "move") {
      const raw = { ...drag.from, x: drag.from.x + rdx, y: drag.from.y + rdy };
      const target = dropTargetAt(raw);
      highlight(drag, target);
      // Show the box where it will land: held inside the parent it would drop into.
      const r = confineTo(raw, target.id);
      setRect(drag.el, r);
      layoutBox(drag.el, b, r.w, r.h);
    } else if (drag.mode === "resize") {
      const { sx, sy } = drag.scale;
      const inner = innerOf(b.parent);
      const { dir, ox, oy, ow, oh } = drag;
      const minW = MIN_PX / sx, minH = MIN_PX / sy;
      // Corners move two edges, sides just the one; the opposite edge stays put.
      if (dir.includes("e")) b.w = clamp(ow + rdx / sx, minW, inner.w - ox);
      if (dir.includes("w")) {
        b.x = clamp(ox + rdx / sx, 0, ox + ow - minW);
        b.w = ox + ow - b.x;
      }
      if (dir.includes("s")) b.h = clamp(oh + rdy / sy, minH, inner.h - oy);
      if (dir.includes("n")) {
        b.y = clamp(oy + rdy / sy, 0, oy + oh - minH);
        b.h = oy + oh - b.y;
      }
      layoutChild(drag.el, sx, sy);
    }
  });

  window.addEventListener("pointerup", () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.mode === "bg") {
      if (!d.moved) select(null);
      return;
    }
    if (!d.moved && d.onNote) {
      d.el.classList.remove("lifting");
      return startNoteEdit(d.b.id, d.sx, d.sy);
    }
    if (d.mode === "click") {
      if (!d.moved) enter(d.b.id);
      return;
    }
    d.el.classList.remove("lifting");
    if (d.moved && d.mode === "move") {
      drop(d);
    } else if (d.moved) {
      save();
    } else if (d.onTitle && d.el.classList.contains("lod-full")) {
      startEdit(d.b.id);
    } else if (d.mode === "move") {
      enter(d.b.id);
    }
  });

  canvas.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.closest(".box").dataset.id;
    const act = btn.dataset.act;
    if (act === "check") toggleDone(id);
    else if (act === "menu") {
      // A second click on the button that opened the menu just closes it.
      if (menuClosed.id === id && performance.now() - menuClosed.at < 300) return;
      select(id);
      const r = btn.getBoundingClientRect();
      openMenu(id, r.right, r.bottom + 6, true);
    }
  });

  canvas.addEventListener("contextmenu", (e) => {
    const el = e.target.closest(".box");
    if (!el || anim || e.target.isContentEditable) return;
    e.preventDefault();
    document.activeElement?.blur?.();
    select(el.dataset.id);
    openMenu(el.dataset.id, e.clientX, e.clientY);
  });

  canvas.addEventListener("dblclick", (e) => {
    const t = e.target;
    if (t === canvas || t === world) {
      const p = toUnits(e.clientX, e.clientY);
      createBox(focus, p.x, p.y, true);
    }
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    // An edited text scrolls sideways with either wheel direction.
    const t = e.target.closest(".body.note")?.querySelector(":scope > .note-text");
    if (t?.isContentEditable) return (t.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY);
    // Scrolling down steps out one level; scrolling up steps into the box under
    // the pointer. A swipe sends a stream of events, so one step per swipe: stay
    // locked until the transition has ended and the wheel has gone quiet, so
    // leftover momentum can't stack more steps.
    clearTimeout(wheelQuiet);
    wheelQuiet = setTimeout(unlockWheel, 250);
    if (wheelLock || anim || !e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    if (e.deltaY > 0) {
      wheelLock = true;
      return goUp();
    }
    // Into the box at this level that holds the pointer, even when it's over one
    // of that box's own children.
    let el = e.target.closest(".box");
    while (el && state.boxes[el.dataset.id]?.parent !== focus) el = el.parentElement?.closest(".box");
    if (!el) return;
    wheelLock = true;
    enter(el.dataset.id);
  }, { passive: false });
  let wheelLock = false, wheelQuiet = 0;
  function unlockWheel() {
    if (anim) wheelQuiet = setTimeout(unlockWheel, 50);
    else wheelLock = false;
  }

  function goUp() {
    if (focus && !anim) enter(state.boxes[focus].parent || "");
  }

  // Clicking the page around the canvas steps out too. Both press and release
  // must land there, so a drag let go out here doesn't count.
  const isOutside = (t) => t === document.body;
  let outsideDown = false;
  document.addEventListener("pointerdown", (e) => (outsideDown = e.button === 0 && isOutside(e.target)));
  document.addEventListener("click", (e) => {
    if (outsideDown && isOutside(e.target)) goUp();
    outsideDown = false;
  });

  function newBoxInView() {
    const inner = innerOf(focus);
    const jitter = (k) => (Math.random() - 0.5) * 60 / k;
    createBox(focus, inner.w / 2 + jitter(kx), inner.h / 2 + jitter(ky), true);
  }
  $("#newBox").onclick = newBoxInView;

  // ---------- keyboard ----------

  window.addEventListener("keydown", (e) => {
    if (!colorModal.hidden) {
      if (e.key === "Escape") closeColor();
      return;
    }
    if (menuFor && e.key === "Escape") return closeMenu();
    if (document.activeElement?.isContentEditable || e.target.closest?.("textarea, input")) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo();
    } else if ((e.key === "Delete" || e.key === "Backspace") && selected) {
      e.preventDefault();
      remove(selected);
    } else if (e.key === "Enter" && selected) {
      e.preventDefault();
      startEdit(selected);
    } else if (e.key === "Escape") {
      if (selected) select(null);
      else goUp();
    } else if (!mod && e.key.toLowerCase() === "n") {
      e.preventDefault();
      if (selected) addChild(selected);
      else newBoxInView();
    }
  });

  // ---------- box menu ----------

  // One menu for a box, opened from its menu button or by right-clicking it.
  const menu = $("#menu");
  let menuFor = null;                      // { id, x, y, alignRight }
  let menuClosed = { id: null, at: 0 };

  function openMenu(id, x, y, alignRight = false) {
    menuFor = { id, x, y, alignRight };
    renderMenu();
    menu.hidden = false;
    placeMenu();
    boxEl(id)?.classList.add("menu-open");
  }

  function placeMenu() {
    const { x, y, alignRight } = menuFor;
    const r = menu.getBoundingClientRect();
    const left = alignRight ? x - r.width : x;
    menu.style.left = clamp(left, 8, innerWidth - r.width - 8) + "px";
    menu.style.top = (y + r.height + 8 > innerHeight ? Math.max(8, y - r.height) : y) + "px";
  }

  function closeMenu() {
    if (!menuFor) return;
    menuClosed = { id: menuFor.id, at: performance.now() };
    boxEl(menuFor.id)?.classList.remove("menu-open");
    menuFor = null;
    menu.hidden = true;
  }

  function renderMenu() {
    const b = state.boxes[menuFor.id];
    if (!b) return closeMenu();
    const item = (m, icon, label, cls = "") =>
      `<button class="mi ${cls}" data-m="${m}" role="menuitem"><span class="mi-icon">${icon}</span><span class="mi-label">${label}</span></button>`;
    const toggle = (m, label, on) =>
      `<button class="mi toggle${on ? " on" : ""}" data-m="${m}" role="menuitemcheckbox" aria-checked="${on}">` +
      `<span class="mi-icon"><span class="tick">${ICON.check}</span></span><span class="mi-label">${label}</span></button>`;
    menu.innerHTML = [
      item("open", ICON.open, "Open"),
      showsText(b) && b.text ? "" : item("add", ICON.add, "Add box inside"),
      '<div class="mi-sep"></div>',
      toggle("actionable", "Actionable", isActionable(b)),
      toggle("title", "Title", hasTitle(b)),
      b.text && kids(b.id).length ? toggle("text", "Show text", !!b.preferText) : "",
      '<div class="mi-sep"></div>',
      item("color", `<span class="mi-swatch c${b.color}"></span>`, "Edit color…"),
      '<div class="mi-sep"></div>',
      item("del", ICON.del, "Delete", "danger"),
    ].join("");
    boxEl(b.id)?.classList.add("menu-open");
  }

  menu.addEventListener("click", (e) => {
    const it = e.target.closest("[data-m]");
    if (!it || !menuFor) return;
    const id = menuFor.id, b = state.boxes[id], m = it.dataset.m;
    if (m === "open" || m === "add" || m === "color" || m === "del") {
      closeMenu();
      if (m === "open") enter(id);
      else if (m === "add") addChild(id);
      else if (m === "color") openColor(id);
      else remove(id);
      return;
    }
    // Toggles keep the menu open so several can be flipped in a row.
    snapshot();
    if (m === "actionable") b.actionable = !isActionable(b);
    else if (m === "done") b.done = !b.done;
    else if (m === "title") {
      // Turning the title off clears it; turning it on opens an empty bar to type into.
      if (b.title) b.title = "";
      else {
        closeMenu();
        titling = id;
        render();
        return startEdit(id);
      }
    }
    else if (m === "text") b.preferText = !b.preferText;
    render();
    placeMenu();
    save();
  });

  menu.addEventListener("contextmenu", (e) => e.preventDefault());

  window.addEventListener("pointerdown", (e) => {
    if (menuFor && !menu.contains(e.target)) closeMenu();
  }, true);
  window.addEventListener("resize", closeMenu);
  window.addEventListener("blur", closeMenu);

  // ---------- color popup ----------

  const colorModal = $("#colorModal");
  let colorFor = null;

  function openColor(id) {
    const b = state.boxes[id];
    if (!b) return;
    colorFor = id;
    $("#colorName").textContent = b.title || "Untitled";
    $("#swatches").innerHTML = Array.from({ length: COLORS }, (_, i) =>
      `<button class="swatch c${i}${i === b.color ? " on" : ""}" data-c="${i}" title="Color ${i + 1}">` +
      `<span class="swatch-well"></span><span class="swatch-tick">${ICON.check}</span></button>`).join("");
    colorModal.hidden = false;
    colorModal.offsetWidth;
    colorModal.classList.add("show");
    $("#swatches .on")?.focus();
  }

  function closeColor() {
    colorFor = null;
    colorModal.classList.remove("show");
    setTimeout(() => { if (!colorFor) colorModal.hidden = true; }, 180);
  }

  colorModal.addEventListener("click", (e) => {
    if (e.target === colorModal) return closeColor();
    const sw = e.target.closest(".swatch");
    const b = sw && state.boxes[colorFor];
    if (!b) return;
    const c = +sw.dataset.c;
    if (c !== b.color) {
      snapshot();
      b.color = c;
      render();
      save();
    }
    closeColor();
  });

  // ---------- a box's text ----------

  // Every box carries a text, and so does the top level; the current one is
  // edited in the side panel.
  const notesText = $("#notesText");
  let notesSnapped = false;   // one undo step per editing session
  const textOwner = () => (focus ? state.boxes[focus] : state);

  function renderNotes() {
    if (document.activeElement !== notesText) notesText.value = textOwner()?.text || "";
  }

  notesText.addEventListener("input", () => {
    const b = textOwner();
    if (!b) return;
    if (!notesSnapped) {
      snapshot();
      notesSnapped = true;
    }
    b.text = notesText.value;
    save();
  });
  notesText.addEventListener("blur", () => (notesSnapped = false));
  notesText.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      notesText.blur();
    }
  });

  // ---------- persistence ----------

  const STORE_KEY = "space-state";
  const status = $("#status");
  let saveTimer = null;

  function save() {
    status.textContent = "Saving…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 200);
  }

  function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      status.textContent = "Saved in this browser";
    } catch {
      status.textContent = "Couldn't save — browser storage unavailable";
    }
  }

  window.addEventListener("beforeunload", () => {
    if (document.activeElement?.isContentEditable) document.activeElement.blur();
    if (saveTimer) flush();
  });

  function seed() {
    // Laid out in format 1's units, which read easier; load converts them.
    const s = { boxes: {}, seq: 2, space: { ...SPACE }, format: 1 };
    const add = (b) => (s.boxes[b.id] = { done: false, z: Object.keys(s.boxes).length + 1, ...b });
    add({ id: "welcome", parent: null, x: 40, y: 40, w: 620, h: 460, title: "Welcome to Space", color: 0 });
    add({ id: "tip1", parent: "welcome", x: 16, y: 16, w: 280, h: 130, title: "Double-click to add", color: 1 });
    add({ id: "tip2", parent: "welcome", x: 320, y: 16, w: 280, h: 130, title: "Drag a header to move", color: 1 });
    add({ id: "tip3", parent: "welcome", x: 16, y: 170, w: 280, h: 130, title: "Drag a corner to resize", color: 1, done: true });
    add({ id: "tip4", parent: "welcome", x: 320, y: 170, w: 280, h: 270, title: "Click a box to open it", color: 1 });
    add({ id: "tip5", parent: "tip4", x: 20, y: 20, w: 240, h: 110, title: "Small boxes show less", color: 2 });
    add({ id: "today", parent: null, x: 720, y: 40, w: 340, h: 240, title: "Today", color: 1 });
    add({
      id: "note", parent: null, x: 720, y: 320, w: 340, h: 180, color: 3,
      actionable: false,
      text: "Every box holds a text as well as boxes.\n\nRight-click a box (or use its ··· button) to add or remove its title, choose text or boxes when it has both, or change its color.\n\nClick a text box to edit it; open any other box to write its text in the panel on the left.",
    });
    return s;
  }

  // Format 1 gave each box a space as many units as the box itself, so a child's
  // numbers shrank with every level. Re-express each child as a fraction of its
  // parent, reading every parent's size before any of them is converted.
  function migrate() {
    if ((state.format || 1) >= FORMAT) return;
    const size = {};
    for (const b of Object.values(state.boxes)) size[b.id] = { w: b.w || 1, h: b.h || 1 };
    for (const b of Object.values(state.boxes)) {
      const p = size[b.parent];
      if (!p) continue;
      b.x /= p.w;
      b.y /= p.h;
      b.w /= p.w;
      b.h /= p.h;
    }
    state.format = FORMAT;
    save();
  }

  function load() {
    try {
      // "space-backup" is the old server-era backup key; adopt it once if present.
      const raw = localStorage.getItem(STORE_KEY) ?? localStorage.getItem("space-backup");
      state = (raw && JSON.parse(raw)) || seed();
    } catch {
      state = seed();
    }
    state.boxes ||= {};
    state.seq ||= 0;
    state.space ||= { ...SPACE };
    migrate();
    // A title used to be hideable on its own; now a hidden title is no title.
    for (const b of Object.values(state.boxes)) {
      if (b.showTitle === false) b.title = "";
      delete b.showTitle;
      // Showing text used to be a plain switch; it now only decides for a box with both.
      if (b.showText) b.preferText = true;
      delete b.showText;
    }
    for (const b of Object.values(state.boxes)) fitInside(b);
    syncFromHash();
  }

  load();
})();
