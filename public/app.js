(() => {
  const $ = (s) => document.querySelector(s);
  const canvas = $("#canvas");
  const world = $("#world");     // the current level's space, laid out in screen pixels

  // Chrome is in screen pixels and never scales; only positions and sizes do.
  const HEAD = 44;          // header height of a box
  const INSET = 8;          // body margin inside a box
  const GAP = 12;           // spacing between stacked boxes
  const NEW_W = 240, NEW_H = 160;   // size of a new box as it appears on screen
  const MIN_PX = 24;        // smallest a box may be resized to on screen
  // Level of detail by on-screen size: full box, title only, or a bare tile.
  const FULL_W = 120, FULL_H = 92;
  const TITLE_W = 56, TITLE_H = 26;
  const COLORS = 6;
  const SPACE = { w: 1600, h: 1000 };   // the finite top-level space
  const PAD = 28;           // screen margin around the fitted space
  const BOTTOM = 76;        // room kept free for the toolbar
  const OPEN_MS = 420;

  const ICON = {
    check: '<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg>',
    add: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>',
    open: '<svg viewBox="0 0 16 16"><path d="M6 3H3v10h10v-3M9 3h4v4M13 3L7.5 8.5"/></svg>',
    del: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    grip: '<svg viewBox="0 0 10 10"><path d="M9 3L3 9M9 7L7 9"/></svg>',
  };

  let state = { boxes: {}, seq: 0 };
  let focus = null;           // id of the box we've opened, null = top level
  let selected = null;
  let drag = null;
  let k = 1;                  // screen pixels per unit of the current level's space
  let anim = null;            // running open/close transition
  const undoStack = [];

  // ---------- model helpers ----------

  const uid = () => Math.random().toString(36).slice(2, 10);
  const kids = (pid) =>
    Object.values(state.boxes).filter((b) => b.parent === pid).sort((a, b) => (a.z || 0) - (b.z || 0));
  const maxZ = () => Object.values(state.boxes).reduce((m, b) => Math.max(m, b.z || 0), 0);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

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

  // Every box is its own space, as many units across as the box is in its parent.
  const innerOf = (pid) => (pid && state.boxes[pid] ? { w: state.boxes[pid].w, h: state.boxes[pid].h } : state.space);

  // Keep a child fully inside its parent by moving it and, if needed, shrinking it.
  function fitInside(b) {
    const inner = innerOf(b.parent);
    b.w = Math.max(1, Math.min(b.w, inner.w));
    b.h = Math.max(1, Math.min(b.h, inner.h));
    b.x = Math.round(clamp(b.x, 0, inner.w - b.w));
    b.y = Math.round(clamp(b.y, 0, inner.h - b.h));
  }

  // The element a level's children are drawn into, and its pixels-per-unit.
  function containerOf(pid) {
    if (pid === focus) return world;
    return boxEl(pid)?.querySelector(":scope > .body") || null;
  }

  function scaleOf(pid) {
    const inner = innerOf(pid);
    const r = containerOf(pid)?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return { sx: k, sy: k };
    return { sx: r.width / inner.w, sy: r.height / inner.h };
  }

  // `x, y` is the top-left corner in the parent's units, or its center when `centered`.
  function createBox(parent, x, y, centered = false) {
    snapshot();
    const p = parent && state.boxes[parent];
    const { sx, sy } = scaleOf(parent);
    const w = Math.round(NEW_W / sx), h = Math.round(NEW_H / sy);
    const b = {
      id: uid(),
      parent,
      x: Math.round(centered ? x - w / 2 : x),
      y: Math.round(centered ? y - HEAD / 2 / sy : y),
      w,
      h,
      title: "",
      done: false,
      color: p ? (p.color + 1) % COLORS : state.seq++ % COLORS,
      z: maxZ() + 1,
    };
    state.boxes[b.id] = b;
    fitInside(b);
    selected = b.id;
    render();
    startEdit(b.id);
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
    el.className = `box c${b.color}${b.done ? " done" : ""}${b.id === selected ? " selected" : ""}`;
    el.dataset.id = b.id;
    el.style.zIndex = b.z || 0;

    const children = kids(b.id);
    const done = children.filter((c) => c.done).length;
    const count = children.length
      ? `<span class="count${done === children.length ? " all" : ""}">${done}/${children.length}</span>`
      : "";

    el.innerHTML = `
      <div class="head">
        <button class="check" data-act="check" title="Mark done">${ICON.check}</button>
        <div class="title" spellcheck="false"></div>
        ${count}
        <div class="actions">
          <button data-act="add" title="Add a box inside">${ICON.add}</button>
          <button data-act="open" title="Open this box">${ICON.open}</button>
          <button data-act="del" title="Delete">${ICON.del}</button>
        </div>
      </div>
      <div class="body">${children.length ? "" : '<div class="hint">Click to open</div>'}</div>
      <div class="resize" title="Resize">${ICON.grip}</div>`;
    el.querySelector(":scope > .head > .title").textContent = b.title;
    const body = el.querySelector(":scope > .body");
    for (const c of children) body.appendChild(buildBox(c));
    return el;
  }

  // Size a box's insides for its on-screen size `w × h`: pick its level of detail,
  // then map its space onto its body and lay out its children there.
  function layoutBox(el, b, w, h) {
    const lod = w >= FULL_W && h >= FULL_H ? "full" : w >= TITLE_W && h >= TITLE_H ? "title" : "bare";
    if (el.dataset.lod !== lod) {
      el.classList.remove("lod-full", "lod-title", "lod-bare");
      el.classList.add("lod-" + lod);
      el.dataset.lod = lod;
    }
    if (lod !== "full") return;
    const sx = (w - INSET * 2) / b.w, sy = (h - HEAD - INSET) / b.h;
    for (const c of el.querySelectorAll(":scope > .body > .box")) layoutChild(c, sx, sy);
  }

  function layoutChild(el, sx, sy) {
    const c = state.boxes[el.dataset.id];
    const r = { x: c.x * sx, y: c.y * sy, w: c.w * sx, h: c.h * sy };
    setRect(el, r);
    layoutBox(el, c, r.w, r.h);
  }

  // Where a level's space sits on screen: as large as fits, centered.
  function fitRect(id = focus) {
    const { w, h } = innerOf(id);
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    const aw = cw - PAD * 2, ah = ch - PAD - BOTTOM;
    const s = Math.max(0.01, Math.min(aw / w, ah / h));
    return { x: (cw - w * s) / 2, y: PAD + (ah - h * s) / 2, w: w * s, h: h * s, k: s };
  }

  function layoutLevel() {
    const f = fitRect();
    k = f.k;
    setRect(world, f);
    for (const el of world.querySelectorAll(":scope > .box")) layoutChild(el, k, k);
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
    $("#zoomOut").hidden = $("#zoomSep").hidden = !focus;
    renderCrumbs();
  }

  function renderCrumbs() {
    const path = [];
    for (let id = focus; id && state.boxes[id]; id = state.boxes[id].parent) path.unshift(state.boxes[id]);
    const crumbs = $("#crumbs");
    crumbs.replaceChildren(crumbs.firstElementChild);
    for (const b of path) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "/";
      const btn = document.createElement("button");
      btn.className = "crumb";
      btn.dataset.id = b.id;
      btn.textContent = b.title || "Untitled";
      crumbs.append(sep, btn);
    }
    document.title = path.length ? `${path.at(-1).title || "Untitled"} · Space` : "Space";
  }

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
    return { x: f.x + dx - INSET, y: f.y + dy - HEAD, w: f.w + INSET * 2, h: f.h + HEAD + INSET };
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

  $("#crumbs").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-id]");
    if (btn) enter(btn.dataset.id);
  });

  // ---------- title editing ----------

  function startEdit(id) {
    const t = boxEl(id)?.querySelector(":scope > .head > .title");
    if (!t || !t.offsetWidth) return;
    t.contentEditable = "true";
    t.focus();
    const r = document.createRange();
    r.selectNodeContents(t);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  canvas.addEventListener("focusout", (e) => {
    const t = e.target;
    if (!t.classList?.contains("title")) return;
    t.contentEditable = "false";
    t.scrollLeft = 0;
    const b = state.boxes[t.closest(".box").dataset.id];
    const title = t.textContent.replace(/\s+/g, " ").trim();
    t.textContent = title;
    if (b && b.title !== title) {
      snapshot();
      b.title = title;
      renderCrumbs();
      save();
    }
  });

  canvas.addEventListener("keydown", (e) => {
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
    return { x: (clientX - r.left) / k, y: (clientY - r.top) / k };
  }

  // What would receive a drop at this point: a box, the current level, a breadcrumb, or nothing.
  // Breadcrumbs are hit by the pointer; boxes by the dragged box's center.
  function dropTargetAt(d, px, py) {
    const atPointer = document.elementFromPoint(px, py);
    const crumb = atPointer?.closest("#crumbs button[data-id]");
    if (crumb) return { el: crumb, id: crumb.dataset.id || null, crumb: true };
    const r = d.el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const box = hit && canvas.contains(hit) && !hit.closest(".toolbar") && hit.closest(".box.lod-full");
    if (box) return { el: box, id: box.dataset.id };
    const inCanvas = (el) => el && canvas.contains(el);
    return inCanvas(hit) || inCanvas(atPointer) ? { el: null, id: focus } : null;
  }

  function highlight(d, target) {
    if (d.target?.el === target?.el) return;
    d.target?.el?.classList.remove("drop-target");
    if (target?.el && target.id !== d.b.parent) target.el.classList.add("drop-target");
    d.target = target;
  }

  // Drops keep the box's on-screen position and size, re-expressed in the new parent's units.
  function drop(d) {
    const { b, target } = d;
    d.target?.el?.classList.remove("drop-target");
    if (!target) {
      // Dropped outside the canvas: put it back.
      undoStack.pop();
      render();
      return;
    }
    if (target.crumb && target.id !== focus) {
      const from = innerOf(b.parent);
      b.parent = target.id;
      const to = innerOf(b.parent);
      b.w = (b.w / from.w) * to.w;
      b.h = (b.h / from.h) * to.h;
      ({ x: b.x, y: b.y } = nextSlot(b.parent));
    } else {
      const r = d.el.getBoundingClientRect();
      const c = containerOf(target.id).getBoundingClientRect();
      b.parent = target.id;
      const { sx, sy } = scaleOf(b.parent);
      b.x = (r.left - c.left) / sx;
      b.y = (r.top - c.top) / sy;
      b.w = r.width / sx;
      b.h = r.height / sy;
    }
    b.x = Math.round(b.x);
    b.y = Math.round(b.y);
    b.w = Math.round(b.w);
    b.h = Math.round(b.h);
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

    const base = { b, el, sx: e.clientX, sy: e.clientY, scale: scaleOf(b.parent) };
    if (t.closest(".resize")) drag = { ...base, mode: "resize", ow: b.w, oh: b.h };
    else if (t.closest(".head") || !el.classList.contains("lod-full"))
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
      drag.el.style.left = drag.from.x + rdx + "px";
      drag.el.style.top = drag.from.y + rdy + "px";
      highlight(drag, dropTargetAt(drag, e.clientX, e.clientY));
    } else if (drag.mode === "resize") {
      const { sx, sy } = drag.scale;
      const inner = innerOf(b.parent);
      b.w = Math.round(clamp(drag.ow + rdx / sx, MIN_PX / sx, inner.w - b.x));
      b.h = Math.round(clamp(drag.oh + rdy / sy, MIN_PX / sy, inner.h - b.y));
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
    else if (act === "add") addChild(id);
    else if (act === "open") enter(id);
    else if (act === "del") remove(id);
  });

  canvas.addEventListener("dblclick", (e) => {
    const t = e.target;
    if (t === canvas || t === world) {
      const p = toUnits(e.clientX, e.clientY);
      createBox(focus, p.x, p.y, true);
    }
  });

  canvas.addEventListener("wheel", (e) => e.preventDefault(), { passive: false });

  const goUp = () => focus && enter(state.boxes[focus].parent || "");
  $("#zoomOut").onclick = goUp;

  function newBoxInView() {
    const inner = innerOf(focus);
    const jitter = () => (Math.random() - 0.5) * 60 / k;
    createBox(focus, inner.w / 2 + jitter(), inner.h / 2 - NEW_H / 2 / k + jitter(), true);
  }
  $("#newBox").onclick = newBoxInView;

  // ---------- keyboard ----------

  window.addEventListener("keydown", (e) => {
    if (document.activeElement?.isContentEditable) return;
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

  // ---------- persistence ----------

  const status = $("#status");
  let saveTimer = null;

  function save() {
    status.textContent = "Saving…";
    try { localStorage.setItem("space-backup", JSON.stringify(state)); } catch {}
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 400);
  }

  async function flush() {
    saveTimer = null;
    try {
      const res = await fetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      });
      if (!res.ok) throw new Error(res.status);
      status.textContent = "Saved";
    } catch {
      status.textContent = "Offline — kept in this browser";
    }
  }

  window.addEventListener("beforeunload", () => {
    if (document.activeElement?.isContentEditable) document.activeElement.blur();
    if (saveTimer) navigator.sendBeacon("/api/state", new Blob([JSON.stringify(state)], { type: "application/json" }));
  });

  function seed() {
    const s = { boxes: {}, seq: 2, space: { ...SPACE } };
    const add = (b) => (s.boxes[b.id] = { done: false, z: Object.keys(s.boxes).length + 1, ...b });
    add({ id: "welcome", parent: null, x: 40, y: 40, w: 620, h: 460, title: "Welcome to Space", color: 0 });
    add({ id: "tip1", parent: "welcome", x: 16, y: 16, w: 280, h: 130, title: "Double-click to add", color: 1 });
    add({ id: "tip2", parent: "welcome", x: 320, y: 16, w: 280, h: 130, title: "Drag a header to move", color: 1 });
    add({ id: "tip3", parent: "welcome", x: 16, y: 170, w: 280, h: 130, title: "Drag a corner to resize", color: 1, done: true });
    add({ id: "tip4", parent: "welcome", x: 320, y: 170, w: 280, h: 270, title: "Click a box to open it", color: 1 });
    add({ id: "tip5", parent: "tip4", x: 20, y: 20, w: 240, h: 110, title: "Small boxes show less", color: 2 });
    add({ id: "today", parent: null, x: 720, y: 40, w: 340, h: 240, title: "Today", color: 1 });
    return s;
  }

  async function load() {
    try {
      const res = await fetch("/api/state");
      if (res.ok) state = await res.json();
      else if (res.status === 404) state = seed();
      else throw new Error(res.status);
    } catch {
      try { state = JSON.parse(localStorage.getItem("space-backup")) || seed(); } catch { state = seed(); }
    }
    state.boxes ||= {};
    state.seq ||= 0;
    state.space ||= { ...SPACE };
    for (const b of Object.values(state.boxes)) fitInside(b);
    syncFromHash();
  }

  load();
})();
