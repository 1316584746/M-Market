MemSearch 的设计思路参考了 [zilliztech/memsearch](https://github.com/zilliztech/memsearch)（MIT）：
Markdown 文件作为记忆的事实来源，索引可以随时重建。本插件代码为 Node 重新编写（BM25 关键词检索），
不包含 memsearch 的源码，也不包含它的向量检索 / Milvus 部分。
