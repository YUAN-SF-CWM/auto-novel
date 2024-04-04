import { SfacgClient } from "../api/client";
import {
    IaccountInfo,
    Ichapter,
    IexpiredInfo,
    InovelInfo,
    IsearchInfos,
    IvolumeInfos,
} from "../types/ITypes";
import { _SfacgCache } from "./cache";
import fse from "fs-extra";
import path from "path";
import Table from "cli-table3";
import { colorize, epubMaker, question, questionAccount } from "../../../utils/tools";

const outputDir = path.join(process.cwd(), "output", "菠萝包轻小说");

export class _SfacgDownloader {
    imagesDir: string = ""
    cookie: string = ""

    static async Once() {
        const download = new _SfacgDownloader()
        await download._Once()
    }


    async Multy(novelId: number, toOrderd: number[]) {
        const client = new SfacgClient()
        const volumeInfos = await client.volumeInfos(novelId)
        volumeInfos
        const have = await _SfacgCache.GetChapterIdsByNovelId(novelId)
        const _tobuy = toOrderd.filter(a => !have?.includes(a))
        const _sortedUsers = await this.userToUse()

    }

    async VolumesToBuy(novelId: number) {
        const client = new SfacgClient()
        const volumes = await client.volumeInfos(novelId)
        
    }

    // 返回按照过期日期进行排序的代币数目和ck，从第一个开始用
    async userToUse() {
        const _users = await _SfacgCache.GetallCookies()
        const userExpiredInfos = await Promise.all((_users ?? []).map(async user => {
            const { result, anonClient } = await SfacgClient.initClient(user as IaccountInfo, "expireInfo")
            const expiredInfos = (result as IexpiredInfo[])
            let validInfos = expiredInfos.filter(info => !info.isExpired && info.has > 0);
            return validInfos.map(info => {
                return {
                    cookie: anonClient.cookie, // 可用ck
                    has: info.has, // 拥有代币
                    expireDate: info.expireDate // 过期日期
                };
            });
        }));
        let allInfos = Array.prototype.concat(...userExpiredInfos);
        let sortedInfos = allInfos.sort((a, b) => new Date(a.expireDate).getTime() - new Date(b.expireDate).getTime());
        return sortedInfos as IexpiredInfo[]
    }


    async _Once() {
        const client = new SfacgClient();
        let books: any;
        const { userName, passWord } = await questionAccount();
        await client.login(userName as string, passWord as string);
        this.cookie = client.cookie ?? ""
        books = await client.bookshelfInfos();
        const novelId = books && (await this.selectBookFromList(books));
        const _save = await question("[1]是(默认)\n[2]否\n是否上传数据库：");
        if (_save !== "2") {
            // 数据库上传&&从数据库下载
            await this.UploadDB(novelId);
            await this.DownLoad("db", novelId)
        } else {
            // 用户直接下载
            client.cookie && await this.DownLoad("user", novelId)
        }
    }

    /**### 待添加数据库重复提示
     * 将小说上传至数据库
     * @param novelId  小说ID
     * @param cookie  用户凭证
     * @param exclude  排除的章节数组
     */
    private async UploadDB(novelId: number) {
        const client = new SfacgClient();
        // 设置ck,拿已购章节
        client.cookie = this.cookie;
        const exclude = await _SfacgCache.GetChapterIdsByNovelId(novelId)
        const volumeInfos = await client.volumeInfos(novelId);
        volumeInfos &&
            await Promise.all(volumeInfos.map((volumes) => {
                volumes.chapterList.map(async (chapter) => {
                    if (chapter.needFireMoney == 0 && (!exclude || !exclude.includes(chapter.chapId))) {
                        const content = await client.contentInfos(chapter.chapId);
                        content && (await _SfacgCache.UpsertChapterInfo({
                            chapId: chapter.chapId,
                            volumeId: volumes.volumeId,
                            ntitle: chapter.ntitle,
                            novelId: novelId,
                            content: content
                        }));
                    }
                });
            }))
    }
    /** 
    * 处理初始化，根据cookie分发下载任务（数据库/个人下载）
    * @param novelId 小说ID
    * @param cookie sf 用户凭证
    */
    async DownLoad(from: "user" | "db", novelId: number) {
        let content: string = "";
        const _client = new SfacgClient();
        const _novelInfo = await _client.novelInfo(novelId);
        _client.cookie = this.cookie;
        const _volumeInfos = await _client.volumeInfos(novelId);

        if (_novelInfo && _volumeInfos) {
            // 初始化路径等
            const head = await this.markdownHead(_novelInfo);
            const novelDir = path.join(outputDir, _novelInfo.novelName,)
            this.imagesDir = path.join(novelDir, "imgs");
            const novelPath = path.join(novelDir, `${_novelInfo.novelName}.md`);
            const epubPath = path.join(novelDir, `${_novelInfo.novelName}.epub`);
            await fse.ensureDir(this.imagesDir);
            await this.imgDownload("cover", _novelInfo.novelCover);
            // 使用 Promise.all 来等待所有下载的完成
            const downloadPromises = _volumeInfos.map(async _volumeInfo => {
                return from == "user"
                    ? await this.UserDownload(_volumeInfo)
                    : await this.ServerDownload(_volumeInfo)

            });
            // 等待所有章节内容下载完成
            const volumesContent = await Promise.all(downloadPromises);
            content += volumesContent.join("\r\n\n");
            // 写入文件
            await fse.outputFile(novelPath, head + content);
            await epubMaker(novelDir, novelPath, epubPath)
        }
    }

    private async UserDownload(
        volumeInfo: IvolumeInfos
    ): Promise<string> {
        const _client = new SfacgClient();
        _client.cookie = this.cookie;
        let content: string = "# " + volumeInfo.title + "\n\n"
        // 创建一个Promise数组来处理每一章的下载
        const chapterDownloadPromises = volumeInfo.chapterList.map(async (_chapter: Ichapter) => {
            // 仅下载已购买的章节
            if (_chapter.needFireMoney === 0) {
                const chapterContent = await _client.contentInfos(_chapter.chapId);
                if (chapterContent) {
                    let formattedContent = "## " + _chapter.ntitle
                    formattedContent += await this.ParseImg(chapterContent, _chapter.chapId);
                    return formattedContent;
                }
            }

        });

        const chaptersContent = await Promise.all(chapterDownloadPromises);

        // 拼接所有章节内容
        content += chaptersContent.filter(Boolean).join("\r\n\n");
        return content;
    }

    async ServerDownload(volumeInfo: IvolumeInfos) {
        const _ids = await _SfacgCache.GetChapterIdsByVolumeId(volumeInfo.volumeId);
        let content: string = "# " + volumeInfo.title + "\n\n"
        if (_ids) {
            // 使用map和Promise.all来处理每一章的下载
            const chapterDownloadPromises = _ids.map(async (_id) => {
                const _chapter = await _SfacgCache.GetChapterContent(_id);
                if (_chapter) {
                    console.log("正在下载" + _chapter.ntitle);
                    let chapterContent = "## " + _chapter.ntitle
                    chapterContent += await this.ParseImg(_chapter.content, _id);
                    return chapterContent;
                } else {
                    return "";
                }
            })
            const chapterContents = await Promise.all(chapterDownloadPromises)
            // 拼接所有章节的内容
            content += chapterContents.join("\r\n\n");
        }
        return content;
    }



    private async ParseImg(
        content: string,
        chapId: number
    ) {
        const regex = /\[img=[^\]]*\](https:\/\/[^[]+)\[\/img\]/;
        const match = content.match(regex);
        if (match) {
            let url = match[1];
            if (url) {
                await this.imgDownload(String(chapId), url);
                content = content
                    .replace(match[0], `![](imgs/${chapId}.jpeg)`)

            }
        }
        return content.replaceAll("\n", "\n\n")

    }

    private async imgDownload(name: string, url: string) {
        const imgPath = path.join(this.imagesDir, `${name}.jpeg`);
        const data = await SfacgClient.image(url);
        await fse.outputFile(imgPath, data);
    }



    // 表格输出，稍作美化
    private async selectBookFromList(
        books: IsearchInfos[]
    ): Promise<number> {
        const table = new Table({
            head: [
                colorize("序号", "blue"),
                colorize("书籍名称", "yellow"),
                colorize("作者", "green"),
                colorize("书籍ID", "purple"),
            ],
        });
        books.forEach((book, index) => {
            table.push([
                colorize(`${index + 1}`, "blue"),
                colorize(`${book.novelName}`, "yellow"),
                colorize(`${book.authorName}`, "green"),
                colorize(`${book.novelId}`, "purple"),
            ]);
        });
        console.log(table.toString());
        const index = await question(
            `请输入${colorize("[1]", "blue")}~${colorize(
                `[${books.length}]`,
                "blue"
            )}序号：`
        );
        return books[(index as number) - 1].novelId;
    }

    private async markdownHead(novelInfo: InovelInfo) {
        // Split the intro into lines and prepend each line with a space
        const formattedIntro = novelInfo.intro.split('\n').map(line => '  ' + line).join('\n');
        return `---
title: '${novelInfo.novelName}'
author: '${novelInfo.authorName}'
lang: 'zh-Hans'
description: |-
${formattedIntro}
cover-image: 'imgs/cover.jpeg'
...\n\n`;
    }
}


// (async () => {

//     const a = new _SfacgDownloader()
//     await a._Once()
// })()