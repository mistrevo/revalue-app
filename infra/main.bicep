// RE:VALUE の Azure のリソース。開発者が用意したリソースグループの中に作る。
// 手順は infra/README.md。鍵の値はここに書かず、Key Vault に入れる。

@description('リソースを置く場所')
param location string = resourceGroup().location

@description('リソースの名前の頭に付ける短い名前（英小文字と数字、7 文字まで）')
@maxLength(7)
param appName string = 'revalue'

@description('Google 側に登録したログイン用のアプリ（OAuth クライアント）のクライアント ID。鍵ではない')
param googleClientId string

@description('GitHub のリポジトリ（所有者/名前）。GitHub Actions からの OIDC ログインを許す相手')
param githubRepo string = 'mistrevo/revalue-app'

@description('Container App で動かすイメージ。最初は Microsoft の仮イメージ（ポート 8080 で待つ）')
param containerImage string = 'mcr.microsoft.com/dotnet/samples:aspnetapp'

@description('Container App を作るか。最初の 1 回は false にして、Key Vault に鍵を入れてから true で流し直す')
param deployApp bool = true

@description('Cosmos DB の無料枠を使うか（無料枠はサブスクリプションに 1 つだけ）。使わないときはサーバーレスにする')
param enableCosmosFreeTier bool = true

var suffix = uniqueString(resourceGroup().id)
var keyVaultName = take('kv-${appName}-${suffix}', 24)
var cosmosAccountName = take('cosmos-${appName}-${suffix}', 44)
var containerAppName = 'ca-${appName}'

// 組み込みの役割の ID
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6' // Key Vault Secrets User
var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c' // Contributor（Container App だけに付ける）
var readerRoleId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7' // Reader（リソースグループ）
var cosmosDataContributorRoleId = '00000000-0000-0000-0000-000000000002' // Cosmos DB Built-in Data Contributor

// ---- ログ ----

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${appName}-${suffix}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// ---- マネージド ID（鍵なしで Azure に認証する仕組み） ----

@description('アプリ用。Key Vault の鍵を読み、Cosmos DB を読み書きする')
resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${appName}-app'
  location: location
}

@description('GitHub Actions 用。デプロイし、評価のために Key Vault の鍵を読む')
resource githubIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${appName}-github'
  location: location
}

resource githubFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: githubIdentity
  name: 'github-main'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:${githubRepo}:ref:refs/heads/main'
    audiences: ['api://AzureADTokenExchange']
  }
}

// ---- Key Vault（鍵の保管庫） ----

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
  }
}

resource appVaultRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, appIdentity.id, keyVaultSecretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource githubVaultRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, githubIdentity.id, keyVaultSecretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: githubIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---- Cosmos DB（データ） ----

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {
  name: cosmosAccountName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    enableFreeTier: enableCosmosFreeTier
    disableLocalAuth: true
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
    capabilities: enableCosmosFreeTier ? [] : [{ name: 'EnableServerless' }]
  }
}

resource cosmosDatabase 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-11-15' = {
  parent: cosmos
  name: 'revalue'
  properties: {
    resource: { id: 'revalue' }
    // 無料枠は 1000 RU/s まで無料。サーバーレスでは指定しない
    options: enableCosmosFreeTier ? { throughput: 1000 } : {}
  }
}

resource cosmosContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: cosmosDatabase
  name: 'items'
  properties: {
    resource: {
      id: 'items'
      partitionKey: {
        paths: ['/userKey']
        kind: 'Hash'
      }
      // TTL を有効にし、期間は各アイテムの ttl で決める
      defaultTtl: -1
    }
  }
}

resource appCosmosRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmos
  name: guid(cosmos.id, appIdentity.id, cosmosDataContributorRoleId)
  properties: {
    roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/${cosmosDataContributorRoleId}'
    principalId: appIdentity.properties.principalId
    scope: cosmos.id
  }
}

// ---- Container Apps ----

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${appName}'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = if (deployApp) {
  name: containerAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${appIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
      // 鍵は Key Vault を参照する。値はここにもリポジトリにも置かない
      secrets: [
        {
          name: 'anthropic-api-key'
          keyVaultUrl: '${vault.properties.vaultUri}secrets/anthropic-api-key'
          identity: appIdentity.id
        }
        {
          name: 'user-key-secret'
          keyVaultUrl: '${vault.properties.vaultUri}secrets/user-key-secret'
          identity: appIdentity.id
        }
        {
          name: 'google-client-secret'
          keyVaultUrl: '${vault.properties.vaultUri}secrets/google-client-secret'
          identity: appIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'app'
          image: containerImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'ANTHROPIC_API_KEY', secretRef: 'anthropic-api-key' }
            { name: 'Auth__UserKeySecret', secretRef: 'user-key-secret' }
            { name: 'Cosmos__Endpoint', value: cosmos.properties.documentEndpoint }
            { name: 'AZURE_CLIENT_ID', value: appIdentity.properties.clientId }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
      }
    }
  }
  dependsOn: [
    appVaultRole
    appCosmosRole
  ]
}

// 組み込み認証（Google）。案内の画面を見せるため、ログインしていない人も通す
resource auth 'Microsoft.App/containerApps/authConfigs@2024-03-01' = if (deployApp) {
  parent: app
  name: 'current'
  properties: {
    platform: { enabled: true }
    globalValidation: {
      unauthenticatedClientAction: 'AllowAnonymous'
    }
    identityProviders: {
      google: {
        enabled: true
        registration: {
          clientId: googleClientId
          clientSecretSettingName: 'google-client-secret'
        }
      }
    }
  }
}

// GitHub Actions 用 ID は、Container App だけを更新できる。リソースグループは読むだけ
resource githubAppRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployApp) {
  scope: app
  name: guid(resourceGroup().id, containerAppName, githubIdentity.id, contributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributorRoleId)
    principalId: githubIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource githubReaderRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, githubIdentity.id, readerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', readerRoleId)
    principalId: githubIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---- 出力（リポジトリ変数に入れる値。鍵ではない） ----

output appUrl string = deployApp ? 'https://${app!.properties.configuration.ingress.fqdn}' : ''
output containerAppName string = containerAppName
output keyVaultName string = vault.name
output githubClientId string = githubIdentity.properties.clientId
output tenantId string = tenant().tenantId
output subscriptionId string = subscription().subscriptionId
