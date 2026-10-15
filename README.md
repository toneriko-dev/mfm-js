<div align="center">
  <a href="https://github.com/toneriko-dev"><img src=".github/assets/toneriko-icon.svg" width="72" height="72" alt="Toneriko"></a>

  <h1>mfm-js</h1>

  <p>MFM(投稿の装飾記法)のパーサー</p>

  <p>
    <a href="https://github.com/toneriko-dev/mfm-js/actions/workflows/test.yml"><img src="https://img.shields.io/github/actions/workflow/status/toneriko-dev/mfm-js/test.yml?branch=main&style=flat-square&label=test" alt="test"></a>
    <a href="https://github.com/toneriko-dev/mfm-js/tags"><img src="https://img.shields.io/github/v/tag/toneriko-dev/mfm-js?style=flat-square&color=26739f&label=release" alt="release"></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-434d54?style=flat-square" alt="MIT"></a>
  </p>

  <p>
    <a href="#提供するもの">提供するもの</a>
    ·
    <a href="#コマンド">コマンド</a>
    ·
    <a href="#misskey-から使う">Misskey から使う</a>
  </p>

  <sub><a href="https://github.com/toneriko-dev">Toneriko</a> の部品</sub>
</div>

<br>

[misskey-dev/mfm.js](https://github.com/misskey-dev/mfm.js) 0.26.0 から分かれた、MFM(投稿の装飾記法)のパーサーです。パッケージ名は `mfm-js` のままなので、Misskey は import を変えずに使えます。

## 提供するもの

| 関数 | 内容 |
| --- | --- |
| `parse(input, { nestLimit })` | MFM を構文木(`MfmNode[]`)にする |
| `parseSimple(input)` | テキストと絵文字だけの構文木にする。ユーザー名などに使う |
| `toString(tree)` | 構文木を MFM に戻す |
| `inspect(tree, action)` | 全ノードを順にたどる |
| `extract(tree, predicate)` | 条件に合うノードを集める |
| `extractMentions(tree)` | メンションを集める |

## コマンド

| コマンド | 内容 |
| --- | --- |
| `bun run build` / `watch` | ビルドする / 監視してビルドする |
| `bun run test` | テスト |
| `bun run typecheck` | 型検査 |

## Misskey から使う

Misskey は release のタグを git の依存として読み込みます。

```json
"mfm-js": "github:toneriko-dev/mfm-js#v<版>"
```

ビルド済みのファイルはタグのコミットにだけ入っているので、install のときにビルドは走りません。npm には公開していません。

版を出すときは、`package.json` の `version` を上げて main に push し、release workflow を手動で実行します。テストとビルドが通ると、`v<版>` のタグが付きます。
