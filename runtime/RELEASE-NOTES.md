# Node.js v24.21.0 LTS 离线安装包（Windows x64）

给**本机没有 Node.js** 的用户准备的便携安装源，用于运行本项目的 B 站评论助手
`bili-helper.js`。安装包来自 Node.js 官方发布页，未做任何修改。

> **大多数人不需要下载它。** 只有「B 站评论抽奖」这一种模式需要 Node；
> 其余 6 种模式（随机数字、座位、名单、员工表、分组、权重）直接在浏览器里跑，
> 双击 `index.html` 就能用，不装 Node 也一样。

| 项目 | 值 |
|---|---|
| 文件 | `node-v24.21.0-x64.msi` |
| 版本 | Node.js v24.21.0 LTS |
| 平台 | Windows 64 位 |
| 大小 | 33,230,848 字节（31.7 MiB） |
| SHA256 | `bb0eaee134f9357f22aea915ee793343e627aefc1e66488164bac6915bce2cac` |
| 官方来源 | https://nodejs.org/dist/v24.21.0/node-v24.21.0-x64.msi |
| 许可 | MIT（Node.js），可自由随项目分发 |

## 怎么装

1. 双击项目里的 `start-helper.bat` —— 检测不到 Node 时会自动打开本安装包；
   也可以直接双击 `node-v24.21.0-x64.msi`。
2. 一路「Next」，安装选项保持默认（会自动把 `node` 加入 PATH）。
   **安装需要管理员权限**；公司电脑若弹出账号密码框，请联系 IT 协助。
3. 装完关掉窗口，**再双击一次** `start-helper.bat`。

## 怎么确认装好了

`Win + R` → 输入 `cmd` → 执行：

```
node -v
```

看到 `v24.21.0` 之类的版本号即成功。之后回到网页，切到「B 站评论」模板，
粘贴视频链接，点「拉取评论」。

## 校验（可选）

```powershell
Get-FileHash .\node-v24.21.0-x64.msi -Algorithm SHA256
```

输出应与上表的 SHA256 一致。

## 装不上怎么办

Node 装不上也能用 B 站抽奖，走兜底路径：

网页上展开「网络设置与手动导入」→ 点「复制抓取脚本」→ 在 B 站视频页按 F12，
把脚本粘到控制台回车 → 把输出的 JSON 粘回「解析粘贴内容」。

代价是串行抓取、上限约 5000 条，比助手慢，也没有楼中楼补拉。

---

## English (short version)

An offline installer of **Node.js v24.21.0 LTS (Windows x64)**, mirrored unmodified from the
official release page. It is only needed to run `bili-helper.js`, the local helper behind the
"bilibili comment" draw mode. The other six modes run entirely in the browser and need nothing.

- File: `node-v24.21.0-x64.msi` — 33,230,848 bytes (31.7 MiB)
- SHA256: `bb0eaee134f9357f22aea915ee793343e627aefc1e66488164bac6915bce2cac`
- Verify: `Get-FileHash .\node-v24.21.0-x64.msi -Algorithm SHA256`
- Requires administrator rights; keep the default options (adds `node` to PATH).
- After install, run `node -v` to confirm, then launch `start-helper.bat` again.

Node.js is licensed under the MIT License and may be redistributed.
