# 第三方数据许可

## JSON5 2.2.3

`src/vendor/json5/index.min.js` 包含 JSON5 2.2.3 官方浏览器 UMD 构建的完整原文，仅在外层增加局部模块包装并导出 `modHubParseJson5`，不改写全局 `JSON5`。本地兼容检查使用该解析器读取 JSON5 声明，不执行声明中的 JavaScript。

- 官方项目：https://github.com/json5/json5/tree/v2.2.3
- 发布元数据：https://registry.npmjs.org/json5/2.2.3
- 发布包：https://registry.npmjs.org/json5/-/json5-2.2.3.tgz
- 发布包完整性：`sha512-XmOWe7eyHYH14cLdVPoyg+GOH3rYX++KpzrylJwSW98t3Nk+U8XOl8FWKOgwtzdb8lXGf6zYwDUzeHMWfxasyg==`
- 原始 `dist/index.min.js` SHA-256：`4bb96d9d53f380ac801819411b8c10868ac9a984de863e56402ac00c2289b9f1`
- 原始 `LICENSE.md` SHA-256：`53e59feb13058722d977c699eb0407c7bce2f93c949b681bbd2ff31698535927`

采用 MIT 许可证；版权与完整许可原文保留于 `src/vendor/json5/LICENSE.md`，并随安装包分发。

## Unicode Unihan 数据

`src/javascript/modhub-search.js` 中的汉字拼音数据来自 Unicode 17.0.0 Unihan 的 `kMandarin` 属性，整理为无声调检索数据。原始数据：https://www.unicode.org/Public/17.0.0/ucd/Unihan.zip。以下保留 Unicode 数据许可原文。

```text
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
```
