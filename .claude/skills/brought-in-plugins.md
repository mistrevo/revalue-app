# 持ち込んだプラグイン

提出用の動画と資料を作るための Claude Code のプラグインです。**開発スタート前に作られたものを持ち込みました**。作成元は株式会社ネクストスケープで、公開してよいと許可を得ています。

| プラグイン | できること | ライセンス |
|---|---|---|
| ns-motion-studio（スキル `/ns-motion-studio:make-video`） | 聞き取りから完成の MP4 まで、モーショングラフィックスの動画を作る | MIT（[LICENSE](ns-motion-studio/LICENSE)） |
| ns-illustrations（スキル `/ns-illustrations:use-illustration`、`/ns-illustrations:draw-illustration`） | 挿絵の SVG 素材を探して資料に置く。素材を描き足す | 表記なし。作成元の許可を得て公開 |

- `.claude/skills/` にプラグインの形のまま置いているので、このリポジトリを信頼して開くと読み込まれます
- 中身は受け取ったままで、書き換えていません
- 製品のコードには組み込んでいません。コンテナにも入りません（`.dockerignore` が `.claude` を除いています）
- 使い方は、それぞれの `README.md` にあります。文中の `nextscape/ns-skills` へのリンクとインストールの手順は作成元のもので、このリポジトリでは使いません
