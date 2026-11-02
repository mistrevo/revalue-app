# Azure の準備（最初の 1 回）

`main.bicep` は、開発者が用意したリソースグループの中に、アプリを動かすリソースをまとめて作る。何を作るかは [00-tech-stack.md](../docs/specs/00-tech-stack.md) の「Azure の構成」にある。

ここに書くのは、手で行う最初の 1 回だけの手順。2 回目からは、main に入った変更を `.github/workflows/deploy.yml` が公開 URL に出す。

## 前もって要るもの

- Azure CLI と、リソースグループへの「所有者」の権限（`main.bicep` が役割の割り当て、つまりマネージド ID への権限の付与を作るため）
- GitHub CLI（`gh`）で、このリポジトリにログインしていること

以下の `<リソースグループ>` などは、自分の値に置き換える。

## 手順

### 0. Google 側でログイン用のアプリを作る（開発者）

Google Cloud のコンソールで OAuth クライアントを作る。種類は「ウェブ アプリケーション」。クライアント ID とクライアントシークレット（鍵）を控える。リダイレクト URI は手順 5 で足す。

### 1. Container App 以外を作る

Key Vault に鍵がまだないので、最初は Container App を作らない（`deployApp=false`）。

```
az deployment group create -g <リソースグループ> -f infra/main.bicep -p deployApp=false googleClientId=<クライアント ID>
```

出力の `keyVaultName` を控える。

### 2. Key Vault に鍵を入れる

自分のアカウントに、Key Vault の「Key Vault Secrets Officer」（鍵を書き込める役割）を付けてから入れる。値はリポジトリにもコマンドの履歴にも残さない。

| 名前 | 中身 | 入れる人 |
|---|---|---|
| `anthropic-api-key` | Claude API の鍵 | 開発者 |
| `google-client-secret` | 手順 0 のクライアントシークレット | 開発者 |
| `user-key-secret` | ログインした人の ID を変換する鍵。乱数でよい | 開発者かエージェント |

`user-key-secret` は、たとえば次のように乱数から作る。

```
az keyvault secret set --vault-name <keyVaultName> --name user-key-secret --value "$(openssl rand -base64 48)" --output none
```

### 3. Container App も作る

```
az deployment group create -g <リソースグループ> -f infra/main.bicep -p deployApp=true googleClientId=<クライアント ID>
```

最初は Microsoft の仮イメージで動く。出力の `appUrl`、`containerAppName`、`githubClientId`、`tenantId`、`subscriptionId` を控える。

### 4. リポジトリ変数を入れる

どれも鍵ではない。GitHub の secrets には何も入れない。

```
gh variable set AZURE_CLIENT_ID --body <githubClientId>
gh variable set AZURE_TENANT_ID --body <tenantId>
gh variable set AZURE_SUBSCRIPTION_ID --body <subscriptionId>
gh variable set AZURE_RESOURCE_GROUP --body <リソースグループ>
gh variable set CONTAINER_APP_NAME --body <containerAppName>
gh variable set APP_URL --body <appUrl>
```

### 5. Google 側にリダイレクト URI を足す（開発者）

手順 0 の OAuth クライアントの「承認済みのリダイレクト URI」に `<appUrl>/.auth/login/google/callback` を足す。OAuth の同意画面を「本番」として公開する。

### 6. 最初のデプロイと、イメージの公開

1. `gh workflow run deploy.yml` で `deploy.yml` を手で流す。イメージが `ghcr.io` に push される
2. `ghcr.io` のパッケージは非公開で作られるので、GitHub のパッケージの設定で一度だけ「公開」にする。Container App が鍵なしでイメージを取れるようにするため
3. 1 回目の更新がイメージを取れずに失敗していたら、`deploy.yml` をもう一度流す

### 7. 確かめる

`<appUrl>/api/health` が 200 を返し、その `commit` が流したコミットの SHA になっていること、`<appUrl>/` で案内の画面が出ることを確かめる。`deploy.yml` も最後に同じことを確かめる。

あわせて、`deploy.yml` の「Container App を新しいイメージに更新する」が、権限のエラー（`AuthorizationFailed`）で止まっていないことを確かめる。GitHub Actions 用の ID には、次の 5 つの役割だけを付けている。足りなければ、エラーに出た操作の名前をここに書き足し、`main.bicep` を直す。

| 範囲 | 役割 | 何のために |
|---|---|---|
| Container App | Contributor | アプリを新しいイメージに更新する |
| Container Apps の環境 | Container Apps Contributor | 更新のときに、アプリが環境に加わる権限（`join/action`）を確かめられることがあるため |
| アプリ用のマネージド ID | Managed Identity Operator | 更新のときに、アプリに付けた ID を付け直す権限（`assign/action`）を確かめられることがあるため |
| リソースグループ | Reader | アプリを探して読む |
| Key Vault の `anthropic-api-key`（鍵 1 つ） | Key Vault Secrets User | 評価のために Claude の鍵を読む。ほかの鍵（`user-key-secret`、`google-client-secret`）は読めない。この割り当ては、鍵を入れたあとの手順 3（`deployApp=true`）で作られる |

確かめた結果: まだ（2026-11-02 時点では Azure のリソースグループがなく、最初のデプロイを流していない）。流したら、ここに日付と結果を書く。

## 作り直すとき

`main.bicep` を流し直すときは、いま動いているイメージを `containerImage` で渡す。渡さないと、仮イメージに戻る。

```
az deployment group create -g <リソースグループ> -f infra/main.bicep -p googleClientId=<クライアント ID> containerImage=ghcr.io/mistrevo/revalue-app:<コミットの SHA>
```

## 手元で Bicep を確かめる

```
az bicep build --file infra/main.bicep --stdout
```

`main.bicep` の説明は、`@description` ではなく `//` のコメントで書く。`@description` は作られる ARM テンプレート（Azure に渡す JSON）に日本語のまま入り、Windows の az CLI がそれを `--stdout` で出せずに止まるため。
