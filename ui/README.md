# Blob Register Visual Editor

用于可视化编辑寄存器 blob：

- 固定支持 4 类定义：`dma` / `activation` / `ctrl` / `parameter`
- 读取二进制 `blob`
- 按位域编辑并导出写回

---

## 1) 本地开发

```bash
cd ui
npm install
npm run dev
```

打开 `http://localhost:5173`。

---

## 2) Ubuntu 服务器部署（推荐：Nginx 静态部署）

前端是纯静态页面，推荐 `build` 后交给 Nginx 托管，不需要 Node 常驻进程。

### 2.1 安装系统依赖

```bash
sudo apt update
sudo apt install -y git curl nginx
```

安装 Node.js 20（用 nvm）：

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 20
nvm use 20
node -v
npm -v
```

### 2.2 拉代码并构建

```bash
git clone <你的仓库地址> regblobvisual
cd regblobvisual/ui
npm install
npm run build
```

`prebuild` 会自动运行 `sync-yaml`，把仓库根目录四个 yaml 同步到打包产物中。

### 2.3 发布到 Nginx 目录

```bash
sudo mkdir -p /var/www/regblobvisual
sudo rsync -av --delete dist/ /var/www/regblobvisual/
```

### 2.4 配置 Nginx

创建站点配置：

```bash
sudo tee /etc/nginx/sites-available/regblobvisual >/dev/null <<'EOF'
server {
    listen 80;
    server_name _;

    root /var/www/regblobvisual;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
EOF
```

启用配置并重载：

```bash
sudo ln -sf /etc/nginx/sites-available/regblobvisual /etc/nginx/sites-enabled/regblobvisual
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

浏览器访问服务器 IP 即可。

---

## 3) HTTPS（可选）

如果有域名，推荐用 Let's Encrypt：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your.domain.com
```

---

## 4) 后续更新流程

每次更新代码后，在服务器执行：

```bash
cd /path/to/regblobvisual/ui
git pull
npm install
npm run build
sudo rsync -av --delete dist/ /var/www/regblobvisual/
sudo systemctl reload nginx
```

---

## 5) 备用方案：Node 预览服务 + systemd（不推荐生产）

如果你暂时不配 Nginx，也可以跑 `vite preview`：

```bash
cd /path/to/regblobvisual/ui
npm run build
npm run preview -- --host 0.0.0.0 --port 4173
```

但正式生产还是建议走 Nginx 静态托管。

---

## 6) YAML 说明

当前只使用 **一个源文件**：

- `/home/rez/workbench/cix/cnnc/cxn/registers.yaml`

`sync-yaml` 会把它同步到：

- `../registers.yaml`（仓库根目录）
- `ui/public/defs/registers.yaml`（前端运行时读取）

前端在运行时会从这个 `registers.yaml` 自动拆分出：

- `dma`
- `activation`
- `ctrl`
- `parameter`

`registers.yaml` 顶层是寄存器分组，分组下是寄存器数组，例如：

```yaml
DMA:
  - name: "0"
    args:
      - name: ext_stride_l
        bits: [0, 15]
        default: 0
```
