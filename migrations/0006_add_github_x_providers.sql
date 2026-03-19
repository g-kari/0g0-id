-- GitHub・Xプロバイダー対応: github_sub/x_subカラム追加
ALTER TABLE users ADD COLUMN github_sub TEXT;
ALTER TABLE users ADD COLUMN x_sub TEXT;

CREATE UNIQUE INDEX idx_users_github_sub ON users(github_sub) WHERE github_sub IS NOT NULL;
CREATE UNIQUE INDEX idx_users_x_sub ON users(x_sub) WHERE x_sub IS NOT NULL;
