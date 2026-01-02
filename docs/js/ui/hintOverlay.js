let overlayEl = null;

function ensureOverlay() {
  if (overlayEl) return overlayEl;

  overlayEl = document.createElement("div");
  overlayEl.id = "hintOverlay";
  overlayEl.style.cssText = `
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(0,0,0,0.55);
    display: none; align-items: center; justify-content: center;
    padding: 16px;
  `;

  overlayEl.innerHTML = `
    <div id="hintCard" style="
      width: min(520px, 100%);
      background: #111;
      color: #fff;
      border-radius: 16px;
      padding: 16px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.35);
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial;
    ">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
        <div>
          <div id="hintTitle" style="font-size:18px; font-weight:700;"></div>
          <div id="hintMeta" style="opacity:.85; margin-top:4px; font-size:13px;"></div>
        </div>
        <button id="hintClose" style="
          border:0; border-radius:10px; padding:10px 12px;
          background:#222; color:#fff; cursor:pointer;
        ">Sluit</button>
      </div>

      <ul id="hintBullets" style="margin:12px 0 0 18px; line-height:1.35;"></ul>

      <div id="hintAlt" style="margin-top:12px; font-size:13px; opacity:.9;"></div>
    </div>
  `;

  document.body.appendChild(overlayEl);

  overlayEl.addEventListener("click", (e) => {
    if (e.target === overlayEl) hideHint();
  });
  overlayEl.querySelector("#hintClose").addEventListener("click", hideHint);

  return overlayEl;
}

export function showHint(hint) {
  const el = ensureOverlay();
  el.style.display = "flex";

  el.querySelector("#hintTitle").textContent = hint.title;

  const pct = Math.round((hint.confidence || 0.65) * 100);
  el.querySelector("#hintMeta").textContent =
    `Risico: ${hint.risk} • Zekerheid: ${pct}%`;

  const ul = el.querySelector("#hintBullets");
  ul.innerHTML = "";
  (hint.bullets || []).forEach((b) => {
    const li = document.createElement("li");
    li.textContent = b;
    ul.appendChild(li);
  });

  const alt = (hint.alternatives || [])
    .map((a) => `${a.decision} (${a.risk})`)
    .join(" • ");
  el.querySelector("#hintAlt").textContent = alt
    ? `Alternatieven: ${alt}`
    : "";
}

export function hideHint() {
  if (!overlayEl) return;
  overlayEl.style.display = "none";
}
