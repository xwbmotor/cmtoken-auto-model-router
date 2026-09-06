# 离线路由学习：请求特征与数据隔离

本工具把冻结的业务任务矩阵与本地原始请求，转换为两个用途不同的文件：`fit.json` 仅含训练／验证特征及结果；`blind.json` 仅含测试请求特征与候选声明。训练程序读取前者，预测程序读取后者。完整测试结果始终留在原矩阵中，最后才交给收益分析器。

它不调用模型、不读取 `.env`、不修改生产配置，也不自动核验业务标签、候选资格或模型版本。成功生成文件仅表示数据契约通过；`demo`、`synthetic` 来源和估算费用保持原样，不能因此变成真实业务证据。

## 运行与文件边界

Node.js 20+，无外部依赖。在仓库根目录运行：

```powershell
node scripts/prepare-routing-learning.mjs --matrix data/business-matrix.json --requests data/business-requests.json --out-dir data/learning-batch-001
node scripts/prepare-routing-learning.mjs --help
node --test tests/learning-data.test.mjs
```

`--out-dir` 必须不存在，其父目录必须存在。输入矩阵和请求只读；已有目录、文件或输入路径不能作为输出覆盖目标。生成三个文件：

| 文件 | 内容 | 应由谁读取 |
| --- | --- | --- |
| `fit.json` | train/validation 请求特征、分组标签、完整候选结果与数据来源 | 拟合与调参程序 |
| `blind.json` | test 请求特征、输入哈希、分组 ID、候选描述与资格声明；无测试类别或结果 | 冻结模型的预测程序 |
| `preparation.json` | 完整源文件路径／哈希、产物哈希、各 split 计数、来源与资格声明状态 | 数据准备审计；不交给训练／预测程序 |

每个文件先写临时文件并 `fsync`，再使用不可覆盖的 hard link 原子发布，最后发布 `preparation.json` 作为完成标记。输出文件系统须支持该操作。三文件不是一个跨文件事务：未出现完成标记的目录不得作为完整批次使用。遇到普通写入失败，仅清理本次创建的确切文件；不会递归删除其他内容。已经存在的批次不会被续写或覆盖。

| 退出码 | 含义 |
| --- | --- |
| 0 | 准备完成；不表示来源已独立核验、模型有效或存在生产收益 |
| 2 | 命令、JSON 或数据契约错误；不会发布新批次 |
| 1 | 文件系统错误，例如输入不存在、输出已存在或不支持原子发布 |

文件分离防止程序无意中获得测试结果，不是操作系统权限隔离。调用方仍需保证拟合／预测进程只打开约定文件，不能再把完整矩阵、原始请求或 preparation 清单传给它们。已有信息被人故意编码进 ID、提示词或描述的情况，也不能靠字段校验自动识别。

## requests.json 契约

```json
{
  "schemaVersion": 1,
  "requests": [
    {
      "taskId": "frozen-task-001",
      "request": {
        "messages": [
          { "role": "system", "content": "按要求回答。" },
          { "role": "user", "content": "将给出的记录转换为 JSON。" }
        ],
        "response_format": { "type": "json_object" }
      },
      "eligibleCandidateIds": ["candidate-a", "candidate-b"]
    }
  ]
}
```

上述单条记录仅展示结构；完整文件必须对应矩阵的全部 train、validation、test 任务。`taskId` 重复、额外记录、缺失记录或输入哈希不匹配均拒绝。

`request` 只支持这些顶层字段：

| 字段 | 范围 |
| --- | --- |
| `messages` | 非空；包含至少一条 user，最后一条为 user 或 tool。允许 system/developer/user/assistant/tool 角色 |
| `tools` | 可选的 function 工具数组；函数支持 name、description、parameters、strict；工具名不可重复 |
| `tool_choice` | none/auto/required 或已声明的具名 function；除 none 外需要工具定义 |
| `parallel_tool_calls` | 布尔值，需要工具定义 |
| `response_format` | text/json_object/json_schema；json_schema 包含 name、schema，可带 description、strict |

消息仅支持 `role`、`content`、可选 `name`，以及对应角色的 `tool_calls` / `tool_call_id`。正文可以是字符串，或 text/image_url/input_audio/file 内容块。image_url 支持 url/detail；input_audio 支持 data/format（wav/mp3）；file 支持 file_id 或 file_data 二选一及可选 filename。历史 assistant 工具调用可用 null 正文。工具调用仅支持 function 类型，其 arguments 保持字符串。

已有 assistant 回答和工具结果可以作为请求历史；最后一条 assistant 回答或前缀被拒绝，避免把本次待评估回答直接作为输入。工具 schema 与 response schema 的业务属性名可以包含 `answer` 或 `success`，它们是请求约束；请求／消息记录中的结果字段则不能携入。

所有结构均严格校验；未知顶层字段、未知消息字段、结果字段、非有限数、undefined、循环对象和稀疏数组都被拒绝。未支持的供应商扩展不能静默丢弃，必须先明确迁移方式。`model`、`inference`、`temperature`、`max_tokens`、`stream` 等不在本版共享任务输入协议内；候选特有的模型、推理参数与输出预算放在矩阵 `candidates` 中，保持对应结果的实际配置。

### 候选资格

可选 `eligibleCandidateIds` 必须是共同候选面板的子集，不允许重复或未知 ID。显式空数组表示没有合格候选，必须保留该任务，由预测侧输出未选择及覆盖阻断，不能扩展回全部候选。准备结果按面板顺序保存，并标记 `eligibilitySource: "caller_declared"`。这是调用方声明，不证明当前线上租户权益、能力、上下文容量或供应商健康已检查。

未提供时，`eligibleCandidateIds` 使用全部面板，标记 `eligibilitySource: "requires_confirmation"`。预测侧应默认拒绝该状态，只有明确进行离线面板实验时才允许使用并保留阻断标记；不能把它解释为所有候选均可上线调用。

## 完整输入哈希

`src/request-features.mjs` 导出：

```javascript
ROUTING_FEATURE_VERSION              // 'routing-request-v1'
ROUTING_FEATURE_NAMES                // 固定顺序的 24 个名称
extractRoutingFeatures(request)      // 同序有限数字数组
routingInputHash(request)            // 64 位小写 SHA-256
```

哈希覆盖所有被接受的输入字段，包括 system、历史、工具定义／调用／结果、输出 schema 和附件标识。规范化仅排序对象键；数组顺序、文本空格、Unicode 表示与显式默认值保持原样。省略字段与显式空数组不视为相同输入。taskId、groupId、人工类别、资格声明、模型及候选推理参数不进入输入哈希。

必须在执行候选、查看结果和划分评估前，使用这一函数冻结任务清单的 `inputHash`。准备工具只比对，绝不会根据当前请求重写原矩阵哈希。已有结果如果采用其他哈希口径，需要核对原始请求及采集规程，不能仅重新标记摘要来冒充输入一致。

附件只使用已给出的内容或标识，不下载 URL、不读取文件路径。可变 URL 或 file_id 背后资源变化不会自动被发现，采集规程须固定附件内容或不可变版本。完整摘要只能检测完全相同的输入，不能识别语义改写、同模板或共同原题；这些仍需预先分到同一 group。

## 固定特征 schema

`routing-request-v1` 不使用人工 task 类别、模型回答、成功标签、费用或时延结果。所有计数类特征使用 `log1p`；字符计数按 Unicode 码点，字节数按 UTF-8，比例分母为合并正文的码点数，空正文比例为 0。

| 顺序 | 名称 | 含义 |
| --- | --- | --- |
| 1 | `log_input_bytes` | 完整规范化请求字节数 |
| 2 | `log_text_chars` | 所有消息文本块／字符串用换行连接后的码点数 |
| 3 | `log_estimated_input_tokens` | 文本、schema、历史工具调用及媒体块的固定启发式估算 |
| 4 | `log_message_count` | 消息数 |
| 5 | `log_user_message_count` | user 消息数 |
| 6 | `log_history_message_count` | 最后一条消息之前的消息数，包含 system/developer |
| 7 | `log_system_chars` | system/developer 文本码点数 |
| 8 | `log_assistant_history_chars` | 已有 assistant 文本码点数 |
| 9 | `log_tool_message_count` | tool 消息数 |
| 10 | `log_tool_definition_count` | 工具定义数 |
| 11 | `log_tool_schema_bytes` | 规范化 `{tools, response_format}` 的字节数，缺省分别为 [] / null |
| 12 | `log_prior_tool_call_count` | 历史 assistant 工具调用数 |
| 13 | `log_media_part_count` | 图片、音频、文件内容块数 |
| 14 | `has_tools` | 是否存在工具定义，0/1 |
| 15 | `has_json_response` | 是否要求 json_object/json_schema，0/1 |
| 16 | `requires_tool` | 是否 required 或指定工具，0/1 |
| 17 | `parallel_tool_calls` | 是否显式设为 true，0/1 |
| 18 | `has_code_fence` | 合并文本是否含三个连续反引号，0/1 |
| 19 | `code_symbol_ratio` | `{ } [ ] ( ) ; = < >` 字符占比 |
| 20 | `digit_ratio` | ASCII 数字占比 |
| 21 | `cjk_ratio` | Han/Hiragana/Katakana/Hangul 字符占比 |
| 22 | `latin_ratio` | ASCII 英文字母占比 |
| 23 | `log_last_turn_chars` | 最后一条消息的文本码点数 |
| 24 | `question_mark_ratio` | 英文／中文问号占比 |

token 估算是 CJK 字符数 + 其余文本字符数/4 向上取整 + schema 字节数/4 向上取整 + 历史工具调用 JSON 字节数/4 向上取整 + 每消息 4 + 每媒体块 4096。该值只是固定输入特征，不是模型 tokenizer、真实计费或候选容量保证。特征名称、顺序或算法变化必须升级版本并重新拟合，不能沿用旧权重。

## 矩阵要求与两份输出

矩阵沿用[业务任务矩阵契约](routing-matrix.md)。本准备步骤额外要求：

- train、validation、test 三类清单均存在。train/validation 每个任务必须有所有候选的结果，失败结果也必须保留；test 可以尚无任何结果，已有部分或全部结果也不会进入产物。
- 同 group 不能跨 split；相同完整输入不能跨 split 或被拆到不同独立组。同组同 split 的重复执行允许保留不同 taskId。
- dataset、候选、任务与观测记录使用已声明字段；未知学习元数据拒绝，防止在描述层夹带测试结果。候选 inference 中不能携带 success、score、cost、latencyMs、evidenceRef、answer 等结果键。本准备协议没有改变原矩阵分析器对历史扩展字段的处理。
- 真实来源是提供者声明，不由文件名或脚本认证；没有将 demo 转为 observed 的参数。

`fit.json` 的数据结构为：

```text
{schemaVersion:1, featureVersion, featureNames, dataset, candidates,
 tasks:[{taskId,groupId,split:"train"|"validation",task,inputHash,features}],
 observations:[仅这些任务的原契约观测], policies:[], selections:[]}
```

`blind.json` 的数据结构为：

```text
{schemaVersion:1, featureVersion, featureNames, datasetId, candidates,
 tasks:[{taskId,groupId,split:"test",inputHash,features,
         eligibleCandidateIds,eligibilitySource}]}
```

两份文件都不含原始提示词。blind 不含测试任务 `.task` 类别、答案、结果、费用、时延、证据引用或全矩阵来源哈希。修改或移除测试结果，不会改变 fit 或 blind 的字节内容；完整源文件哈希变化只记录在独立 preparation 清单中。训练集本身的来源说明与结果证据仍保留在 fit，不能把完整矩阵哈希追加进 fit 后再用它计算模型版本。

完成准备后，先在 train 拟合、validation 选择超参数并冻结模型，再只用 blind 预测；最后把选择表与原矩阵汇合到[收益分析器](routing-matrix.md)。当前实现提供可检验的数据边界，尚未证明请求级成功率已校准、已取得真实节省或优于线上标杆。
