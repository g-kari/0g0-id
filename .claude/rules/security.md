# セキュリティ規約

## JWT
- アルゴリズム: **ES256のみ**（HS256禁止）
- `jose` ライブラリ + WebCrypto使用
- kidをヘッダーに必ず含める
- claims: iss/sub/aud/exp/iat/jti/kid 必須

## Cookie設定
```
Set-Cookie: __Host-session=...; HttpOnly; Secure; SameSite=Lax; Path=/
```
- `__Host-` prefix必須（Secureフラグ強制、Pathは/のみ）
- `HttpOnly` 必須
- `Secure` 必須
- `SameSite=Lax` 必須

## CSRF対策
- Origin検証ミドルウェアを変更系エンドポイントに適用
- `SameSite=Lax` Cookie併用

## OAuth / Google認証
- **state + PKCE (S256)** 必須
- BFFセッションCookieにstate/PKCE verifierを保存
- `email_verified: true` 必須チェック
- redirect_uriは完全一致（正規化後）で検証

## redirect_uri正規化ルール
- `https` 必須（localhost開発時のみ `http://localhost` 例外）
- fragment (`#`) 禁止
- 既定ポート除去（443, 80）
- host小文字化

## 管理者権限
- DBの `role` フィールドで判定（'admin' | 'user'）
- `BOOTSTRAP_ADMIN_EMAIL` 環境変数で初回のみ初期管理者付与
- `ADMIN_EMAIL` 環境変数での判定は禁止

## ハッシュ
- `client_secret_hash`: SHA-256（WebCrypto）
- `token_hash`: SHA-256（WebCrypto）
- `code_hash`: SHA-256（WebCrypto）

## リフレッシュトークン
- ローテーション必須
- reuse detection: 同一family_idのトークンが再使用された場合、family全体を失効
