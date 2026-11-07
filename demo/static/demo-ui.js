// デモ版だけの画面：お知らせの帯、「Discord の通知を届けてみる」、注意書き、録画
"use strict";

(() => {
  const B = window.DemoBackend;
  const h = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const TAG = { added: "追加", pending: "確認待ち", duplicate: "登録済み", merged: "まとめた", updated: "変更", cancelled: "取り消し", change_pending: "確認待ち", skipped: "見送り" };
  const SERVER = "学科サーバー";
  const PLACES = {
    dm: { label: "友だちからの DM", channel: "Discord DM", author: "ゆうき" },
    team: { label: `${SERVER} の #チーム連絡`, channel: `Discord ${SERVER} #チーム連絡`, author: "リーダー" },
    info: { label: `${SERVER} の #お知らせ`, channel: `Discord ${SERVER} #お知らせ`, author: "先生" },
  };

  // 見本の例文（開いた日によって「来週水曜」などがずれても、そのまま試せる書き方にしている）
  function examples() {
    const r = B.rules();
    const name = r.names[0] || "たろう";
    const group = r.groups[0] || "";
    return [
      { place: "dm", text: "あさって11時から映画行かない？駅前集合で！", what: "友だちからの誘い（自分宛て）" },
      { place: "team", text: `${name}、来週火曜の10時から面談お願いします。場所は進路指導室です`, what: "名前が出てくる（自分宛て）" },
      { place: "info", text: `${group ? `@${group}` : "@here"} 来週金曜15時から就職説明会があります。大講義室に集合してください`, what: "全体への連絡（確認待ちに入る）" },
      { place: "dm", text: "ごめん、明日のご飯20時からにしてもいい？", what: "登録済みの予定の変更（元に戻せる）" },
      { place: "team", text: "今日のチームミーティングは中止になりました", what: "登録済みの予定の取り消し" },
    ];
  }

  // ---------- お知らせの帯 ----------
  const banner = document.createElement("div");
  banner.className = "demo-banner";
  banner.innerHTML = `<div class="demo-banner-inner">
      <span><strong>デモ版</strong>　見本の予定で動いています。本物のアプリは PC に常駐し、Discord や Slack の通知を自動で読み取ります。</span>
      <span class="spacer"></span>
      <button type="button" id="demo-video-open" hidden>本物の動きを動画で見る</button>
      <button type="button" id="demo-reset">最初の状態に戻す</button>
    </div>`;
  document.body.prepend(banner);

  // ---------- 通知を届ける ----------
  const panel = document.createElement("section");
  panel.className = "demo-notify";
  panel.setAttribute("aria-labelledby", "demo-notify-title");
  panel.innerHTML = `
    <div class="demo-notify-head">
      <h2 id="demo-notify-title">Discord の通知を届けてみる</h2>
      <button type="button" class="toggle" id="demo-toggle" aria-expanded="true">閉じる</button>
    </div>
    <div id="demo-notify-inner">
      <p class="lead">本物のアプリは、PC に出た Discord や Slack の通知を自動で読み取り、予定をカレンダーに登録します。デモ版では、ここから通知が届いたことにできます。例を選ぶか、自由に書いて「通知を届ける」を押してください。</p>
      <div class="demo-notify-body">
        <div>
          <h3>例</h3>
          <div class="demo-examples" id="demo-examples"></div>
          <p class="demo-note" id="demo-rules-note"></p>
        </div>
        <div>
          <form class="demo-form" id="demo-form">
            <div class="row2">
              <label>送られてきた場所<select name="place">${Object.entries(PLACES).map(([k, p]) => `<option value="${k}">${h(p.label)}</option>`).join("")}</select></label>
              <label>送った人<input name="author" maxlength="30" autocomplete="off"></label>
            </div>
            <label>メッセージ<textarea name="text" rows="3" maxlength="500" placeholder="例: 明日の19時から駅前でご飯いこう"></textarea></label>
            <button class="send" type="submit">通知を届ける</button>
          </form>
          <div class="demo-result" id="demo-result" aria-live="polite"></div>
        </div>
      </div>
    </div>`;
  const navbar = document.querySelector(".navbar");
  navbar.after(panel);

  const form = panel.querySelector("#demo-form");
  const result = panel.querySelector("#demo-result");
  const setPlace = (key, author) => {
    form.place.value = key;
    form.author.value = author ?? PLACES[key].author;
  };
  form.place.addEventListener("change", () => setPlace(form.place.value));
  setPlace("dm");

  function renderExamples() {
    panel.querySelector("#demo-examples").innerHTML = examples().map((ex, i) => `
      <button type="button" class="demo-example" data-example="${i}"><small>${h(PLACES[ex.place].label)} ・ ${h(ex.what)}</small>${h(ex.text)}</button>`).join("");
    const r = B.rules();
    panel.querySelector("#demo-rules-note").textContent =
      `このデモでは、あなたの名前を「${r.names.join("・") || "（なし）"}」、所属グループを「${r.groups.join("・") || "（なし）"}」としています（右上の設定ボタンの「登録の基準」で変えられます）。`;
  }
  renderExamples();

  panel.addEventListener("click", (e) => {
    const ex = e.target.closest("[data-example]");
    if (ex) {
      const item = examples()[Number(ex.dataset.example)];
      setPlace(item.place);
      form.text.value = item.text;
      form.text.focus();
    }
  });

  const toggle = panel.querySelector("#demo-toggle");
  toggle.addEventListener("click", () => {
    const inner = panel.querySelector("#demo-notify-inner");
    inner.hidden = !inner.hidden;
    toggle.textContent = inner.hidden ? "開く" : "閉じる";
    toggle.setAttribute("aria-expanded", String(!inner.hidden));
  });
  if (window.matchMedia("(max-width: 560px)").matches) toggle.click(); // スマホでは最初は閉じておく

  // PC に出る通知
  let toastTimer = null;
  function showOsToast(place, author, text) {
    let el = document.querySelector(".demo-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "demo-toast";
      el.setAttribute("role", "status");
      document.body.append(el);
    }
    const p = PLACES[place];
    const title = place === "dm" ? author : `${author} (${p.channel.split(" ").pop()}, ${SERVER})`;
    el.innerHTML = `<div class="app"><i></i>Discord</div><div class="title">${h(title)}</div><div class="body">${h(text)}</div>`;
    requestAnimationFrame(() => el.classList.add("show"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 6000);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const place = form.place.value;
    const author = form.author.value.trim() || PLACES[place].author;
    const text = form.text.value.trim();
    if (!text) { result.innerHTML = `<div class="line error">メッセージを入れてください</div>`; return; }
    const button = form.querySelector(".send");
    button.disabled = true;
    showOsToast(place, author, text);
    result.innerHTML = `<div class="line muted"><span class="spinner gray"></span>アプリが通知を読み取っています…</div>`;
    try {
      const out = await B.receiveNotification({ author, channel: PLACES[place].channel, text });
      if (out.results.length) {
        result.innerHTML = out.results.map((r) => `<div class="line"><span class="result-tag ${h(r.status)}">${TAG[r.status] || h(r.status)}</span><span>${h(r.event.label)}</span></div>`).join("")
          + `<div class="hint">${out.results.some((r) => ["pending", "change_pending"].includes(r.status)) ? "「確認待ち」タブで、追加するかどうかを選べます。" : "カレンダーと「通知」タブに反映されました。"}</div>`;
        const first = out.results[0];
        if (typeof toast === "function") toast(`${TAG[first.status] || ""}: ${first.event.label}`);
      } else {
        result.innerHTML = `<div class="line muted">${h(out.skipped || "予定は見つかりませんでした")}</div>`;
      }
      form.text.value = "";
    } catch (err) {
      result.innerHTML = `<div class="line error">${h(err.message || "読み取れませんでした")}</div>`;
    } finally {
      button.disabled = false;
      if (typeof render === "function") await Promise.all([render(true), refreshStatus()]);
    }
  });

  // ---------- 注意書き ----------
  const footer = document.createElement("footer");
  footer.className = "demo-footer";
  footer.textContent = "デモ版では、予定の読み取りにクラウドの LLM を使っています（本物のアプリは PC の中のローカル LLM で読み取り、連絡の内容を外に送りません）。個人情報は入力しないでください。入力した内容や予定は、このブラウザの中にだけ保存されます。";
  document.querySelector("#statusbar").after(footer);

  // 貼り付け（＋）の注意書き
  window.updateAnalyzeNote = function () {
    const note = document.querySelector("#analyze-note");
    if (note) note.textContent = "デモ版では文章だけ読み取れます（画像・PDF の読み取りは本物のアプリで動きます）。ふだんは貼り付けなくても、通知から自動で読み取ります。";
  };
  window.updateAnalyzeNote();

  // ---------- 最初の状態に戻す ----------
  document.querySelector("#demo-reset").addEventListener("click", async () => {
    if (!confirm("予定・通知・設定を見本の状態に戻しますか？")) return;
    B.reset();
    result.innerHTML = "";
    renderExamples();
    if (typeof render === "function") await Promise.all([render(true), refreshStatus()]);
  });

  // 登録の基準を保存したら、例文と説明を合わせる
  document.querySelector("#settings-form")?.addEventListener("submit", () => setTimeout(renderExamples, 300));

  // ---------- 録画（demo-config.js の video に置き場所を書いたら表示する） ----------
  const VIDEO = (window.DEMO_CONFIG || {}).video;
  if (VIDEO) {
    const open = document.querySelector("#demo-video-open");
    open.hidden = false;
    const dialog = document.createElement("dialog");
    dialog.className = "demo-video";
    dialog.innerHTML = `<video src="${h(VIDEO)}" controls playsinline preload="metadata"></video><button type="button" class="close" aria-label="閉じる">×</button>`;
    document.body.append(dialog);
    open.addEventListener("click", () => { dialog.showModal(); dialog.querySelector("video").play().catch(() => {}); });
    dialog.querySelector(".close").addEventListener("click", () => { dialog.querySelector("video").pause(); dialog.close(); });
    dialog.addEventListener("close", () => dialog.querySelector("video").pause());
  }
})();
