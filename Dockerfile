# RE:VALUE のコンテナ。画面を作る → 裏側を publish → 実行用の小さいイメージ、の 3 段
# docker build -t revalue .

# 1. 画面を作る（結果は src/Revalue.Server/wwwroot に出る）
FROM node:24-bookworm-slim AS web
WORKDIR /repo
COPY src/web/package.json src/web/package-lock.json src/web/
RUN npm --prefix src/web ci
COPY src/shared src/shared
COPY src/web src/web
RUN npm --prefix src/web run build

# 2. 裏側を publish する
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS server
WORKDIR /repo
COPY src/Revalue.Server/Revalue.Server.csproj src/Revalue.Server/
RUN dotnet restore src/Revalue.Server/Revalue.Server.csproj
COPY src/Revalue.Server src/Revalue.Server
COPY --from=web /repo/src/Revalue.Server/wwwroot src/Revalue.Server/wwwroot
RUN dotnet publish src/Revalue.Server/Revalue.Server.csproj -c Release -o /app --no-restore

# 3. 実行する。root でない利用者（公式イメージの app）で、ポート 8080 で待つ
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
COPY --from=server /app .
# どのコミットから作ったか。/api/health が返し、デプロイのあとに新しいイメージが動いているかを確かめるのに使う
# docker build --build-arg BUILD_COMMIT=<コミットの SHA>
ARG BUILD_COMMIT=local
ENV Build__Commit=$BUILD_COMMIT
ENV ASPNETCORE_HTTP_PORTS=8080
EXPOSE 8080
USER $APP_UID
ENTRYPOINT ["dotnet", "Revalue.Server.dll"]
