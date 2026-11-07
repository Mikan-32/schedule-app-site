// デモ版の設定
window.DEMO_CONFIG = {
  // 予定の読み取りに使う中継（Cloudflare Workers）の URL。公開したら書き換える
  // 例: "https://schedule-demo-extract.＜あなたのサブドメイン＞.workers.dev"
  workerUrl: "https://schedule-demo-extract.keigo-lab-996f4d.workers.dev",
  // 本物の動きの録画。video フォルダに置いたら "video/real.mp4" のように書く（空なら「動画で見る」を出さない）
  video: "",
};
