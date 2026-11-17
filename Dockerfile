# 纯静态站点，用 Caddy 自带 file-server，无需构建
FROM caddy:2-alpine

COPY . /srv
WORKDIR /srv

EXPOSE 80
CMD ["caddy", "file-server", "--root", "/srv", "--listen", ":80"]
