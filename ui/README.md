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

## 5) 用 systemctl 常驻（你要的方式）

如果你想把前端进程交给 `systemctl` 管理，可以用 `vite preview` 挂成服务。

### 5.1 创建系统用户（可选）

```bash
sudo useradd -r -s /usr/sbin/nologin regblob || true
```

### 5.2 放置服务文件

仓库里提供了模板：`deploy/regblobvisual.service.example`。  
复制到系统目录并按你的路径修改：

```bash
cd /path/to/regblobvisual/ui
sudo cp deploy/regblobvisual.service.example /etc/systemd/system/regblobvisual.service
sudo nano /etc/systemd/system/regblobvisual.service
```

你至少需要改这几项：

- `User` / `Group`（比如 `regblob` 或你的登录用户）
- `WorkingDirectory`（改成你的真实项目路径）
- `ExecStart`（默认 `npm run preview -- --host 0.0.0.0 --port 4173`）

### 5.3 启用并启动

```bash
cd /path/to/regblobvisual/ui
npm install
npm run build
sudo systemctl daemon-reload
sudo systemctl enable regblobvisual
sudo systemctl start regblobvisual
```

### 5.4 查看状态与日志

```bash
sudo systemctl status regblobvisual
sudo journalctl -u regblobvisual -f
```

### 5.5 更新后重启

```bash
cd /path/to/regblobvisual/ui
git pull
npm install
npm run build
sudo systemctl restart regblobvisual
```

### 5.6（可选）Nginx 反代到 systemd 服务

如果服务监听在 `127.0.0.1:4173` 或 `0.0.0.0:4173`，可用 Nginx 反代：

```nginx
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:4173;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> 说明：纯静态页面最佳实践还是“`npm run build` + Nginx 直接托管 `dist`”。  
> 你如果明确要 `systemctl`，上面这套可以稳定运行。

---

## 6) YAML 说明

运行时读取以下 4 个文件：

- `DMA.yaml`
- `Activation.yaml`
- `Control.yaml`
- `Parameter.yaml`

`sync-yaml` 规则：

- 文件存在且非空：直接使用
- 文件为空或缺失：尝试从 `registers.yaml` 自动拆分生成

每个 YAML 顶层是寄存器分组，分组下是寄存器数组，例如：

```yaml
DMA:
  - name: "0"
    args:
      - name: ext_stride_l
        bits: [0, 15]
        default: 0
```
