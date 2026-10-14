# mfm-js

MFM(投稿の装飾記法)のパーサーです。[misskey-dev/mfm.js](https://github.com/misskey-dev/mfm.js) の upstream コミット `356ba3e8446f86d76c35fe1a931edef90ba2b975`(mfm-js 0.26.0)から分かれたフォークです。ライセンスは MIT のままで、upstream の著作権表示は [LICENSE](./LICENSE) に残してあります。

公開されているパッケージと同じ `mfm-js` の名前を保っているので、Misskey の backend と frontend は import の記述を変えずに使えます。upstream との同期は手作業で行います。パーサーの挙動をこのリポジトリで最適化し、拡張するためです。

## 提供するもの

| 関数 | 内容 |
| --- | --- |
| `parse(input, { nestLimit })` | MFM の文字列を構文木(`MfmNode[]`)に変換する |
| `parseSimple(input)` | テキスト・Unicode 絵文字・カスタム絵文字・`plain` だけを扱う簡易の構文木(`MfmSimpleNode[]`)に変換する。ユーザー名やプロフィールの項目名に使う |
| `toString(tree)` | 構文木を MFM の文字列に戻す |
| `inspect(tree, action)` | 構文木の全ノードを順にたどる |
| `extract(tree, predicate)` | 条件に合うノードを集める |
| `extractMentions(tree)` | メンションだけを集める |

## コマンド

| コマンド | 内容 |
| --- | --- |
| `bun run build` | ビルドする |
| `bun run watch` | 監視してビルドを繰り返す |
| `bun run test` | テストを実行する |
| `bun run typecheck` | 型検査を行う |

## Misskey から使う

[Misskey (Toneriko)](https://github.com/haru0416-dev/misskey) は、このリポジトリのタグを git の依存として `"mfm-js": "github:toneriko-dev/mfm-js#v<版>"` の形で参照します。main には `built/` を置かず、タグのコミットにだけビルド済みの `built/` が入ります。依存として入れるときにビルドが走らないので、利用側に tsdown や TypeScript は要りません。npm には公開していません。

タグは GitHub Actions の release workflow で作ります。`package.json` の `version` を上げて main に push してから、workflow を手動で実行します。workflow はテストとビルドを通したあと、`built/` を足したコミットに `v<版>` のタグを付けて push します。同じ版のタグがあれば止まります。
