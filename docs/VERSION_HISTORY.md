# 查看历史版本与 GitHub 备份

2026-10-21 开始为当前源码建立 Git 版本记录。第一个快照标签为 `snapshot-2026-10-21`，内容是贝斯音名、彩色三轨谱、手写演奏标记这一版。它是源码保存点，不表示完成全部 V1.0 产品规划。

此前项目没有 Git 历史，不能从这次新建的仓库直接切回第一版。`TEST_REPORT.md` 和 `ROADMAP.md` 保留了以前的功能记录，但不是可运行的旧源码。`docs/verification/backups/` 中的歌曲 JSON 备份也不是整个软件备份。

## 用图形界面查看与保存

1. 安装 [GitHub Desktop](https://desktop.github.com/)，登录自己的 GitHub 账号。
2. 选择 **File → Add Local Repository**，目录填写 `D:\zzMUSIC\BassChartStudio`。
3. 打开 **History** 查看每个提交，点选后查看具体文件变化。
4. 第一次上传，点击 **Publish repository**，仓库名可用 `BassChartStudio`，保持 **Keep this code private** 勾选，再发布。
5. 以后每次修改完成，在 **Changes** 填写本次修改说明，点击 **Commit to main** 保存到本机，再点击 **Push origin** 同步到 GitHub。仅修改文件或点击 Commit 不等于已经上传云端。

官方说明：[添加本地仓库](https://docs.github.com/en/desktop/adding-and-cloning-repositories/adding-a-repository-from-your-local-computer-to-github-desktop)、[发布私有仓库](https://docs.github.com/en/desktop/overview/creating-your-first-repository-using-github-desktop#part-4-publishing-your-repository-to-github)。

## 在 GitHub 查看旧版

上传后，仓库的 **Commits** 显示提交记录，**Tags** 显示命名快照。打开某次提交可以查看当时的文件及修改。需要运行旧版时，优先下载该快照源码到另一个文件夹，避免覆盖正在工作的目录；按那个版本的 README 重新安装依赖。

不要把旧版程序直接连接到唯一一份现有歌曲数据。先复制歌曲工程，再测试不同版本是否兼容。

## 本地命令（可选）

在项目目录打开 PowerShell：

```powershell
git log --oneline --decorate
git tag --list
git show --stat snapshot-2026-10-21
```

前两条列出版本与标签，第三条查看此快照包含的文件。查看历史不会修改当前代码。

## 哪些内容保存在哪里

Git / GitHub 保存源码、依赖清单、启动脚本、自动测试和说明文档。已经设置忽略歌曲、人声/贝斯分轨、歌词工程、模型、虚拟环境、依赖目录、导出文件及私密配置，避免把这些大文件和个人素材上传。

歌曲及人工校谱数据保存在 `backend/data/projects/`。请另行将整个目录复制到移动硬盘或自己的备份盘；只保存源码 ZIP 或 Git 仓库并不能恢复歌曲工程。备份时先停止分析和编辑，避免复制到正在写入的一半文件。

`D:\zzMUSIC\BassChartStudio-backups\` 中的源码 ZIP 用于直接解压查看；Git bundle 保存 Git 历史，可在其他机器使用 `git clone 路径.bundle 新目录` 恢复。它们都不包含歌曲与模型。

本说明不代表已上传 GitHub。是否已同步，以 GitHub 仓库实际可见的提交和标签为准。
