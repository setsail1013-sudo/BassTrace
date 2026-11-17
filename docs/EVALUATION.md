# BassTrace P0 准确性评估协议

版本：1。日期：2026-11-10。

本文只定义以后如何在有使用授权的曲目上测量真实 Demucs/HTDemucs 分离和可选 faster-whisper 歌唱识别。仓库里的这份协议、字段和公式单测都不包含已测得的准确率、听感分或耗时。30 首授权曲库和其中 5–10 首人工精标仍然没有跑过。

本地入口：

```powershell
python -m backend.evaluation.runner
python -m backend.evaluation.runner --schema
python -m backend.evaluation.runner --corpus D:\eval\authorized-corpus --output D:\eval\p0-report.json
```

不带 `--corpus` 时，进程写出一份状态为 `not_evaluated` 的报告：每一项 `value` 都是空，退出码为 3。这表示评估没有执行，不是准确率通过。`--schema` 只打印字段定义，退出码 0 只说明定义已经打印，同样不是测量结果。

## 与已经做过的检查分开

[TEST_REPORT.md](TEST_REPORT.md) 里的单元测试、页面检查，以及 `backend/verify_bass_audio.py` 对一条现有约 276 秒贝斯分轨的只读冒烟，都只说明对应的实现规则或文件没有被改写。那次冒烟写明自己不是新的 Demucs 运行，也不是音高准确率基准。`backend/tests/test_demucs_runtime.py` 只用替身检查 `BASSCHART_DEMUCS_PYTHON` 的解释器选择。可选依赖见 `requirements-ai.txt`；此前 tiny 权重没有下载成功，真实歌唱识别没有结果。这些记录都继续有效。合成公式样例只核对下面的算术，不能引用为歌曲分数。

## 这个入口不做的事

评估进程只读仓库外的 JSON，并用文件大小确认音频还在本机。它不打开音频内容，不调用 Demucs，不构造 Whisper 模型，不下载权重，不上传音频或歌词，不读写 `backend/data/projects`，也不调用工程合并。曲库路径落在仓库内时直接拒绝，连清单都不读。报告若指向仓库内的路径，也只打印到标准输出，不把文件写进仓库。

因此报告里的这些字段固定为：`ranDemucs`、`ranWhisper`、`downloadedWeights`、`openedAudio`、`rewroteProjects`、`uploadedAudio` 都是假；`accuracyClaim` 是假；`qualityPassed` 是空。退出码 0 只在协议要求的记录都齐备时出现，表示“报告写完了”，不表示音质或识别通过合格线。本协议不设合格线，报告里也没有阈值。不要把这个退出码接进持续集成当作准确率门禁。

缺材料时的退出码是 3（没有任何测量）或 4（有局部测量，或曲目数、语种、精标数量还没达到 P0）。命令行本身无法解析时，参数解析器使用自己的退出码 2。

## 曲库与授权

P0 基准是 30 首有使用授权的完整原曲，覆盖中文、英文和日文流行曲，以及不同的速度和编配。其中 5–10 首另建完整人工精标。曲目放在仓库外，例如：

```text
D:\eval\authorized-corpus\
  manifest.json
  tracks\
    <trackId>\
      audio\mix.wav
      gold.json
      prediction.json
      listening.json
      human-edit.json
```

`trackId` 只使用字母、数字、下划线和连字符。音频路径相对于该曲目目录，不能是绝对路径，也不能包含 `..`。后缀限于 wav、mp3、flac、m4a、ogg。评估进程只确认文件存在且大小大于 0，不解码。`docs/verification/` 和用户工程仍按 `.gitignore` 留在本机；评估报告也不提交。

`manifest.json` 的授权字段：

| 字段 | 要求 |
| --- | --- |
| holder | 授权方 |
| scope | 允许的用途。评估只在本机进行 |
| grantedOn / expiresOn | `YYYY-MM-DD`。到期日早于评分当天则整份曲库不计分 |
| reference | 本机能对上的授权编号，不是要去下载的链接 |
| localOnly | 必须为真 |
| redistributionAllowed | 必须为假 |
| coversTrackIds | 必须与清单中的曲目编号完全一致，否则整份不计分 |

清单不足或多于 30 首、三种语言没有齐、完整精标不在 5–10 首之间时，可以计算已经具备的项目，但曲库级状态不能成为 `evaluated`。字段的机器定义用 `python -m backend.evaluation.runner --schema` 打印，来源是 `backend/evaluation/schema.py`。

## 精标

完整精标是 `gold.json`，六层都要有，而且每一层至少一条：

| 层 | 内容 |
| --- | --- |
| tempo | 四分音符 BPM、拍号、第一拍偏移，以及每个小节的下拍时间。第一个下拍与偏移一致，下拍严格递增 |
| sections | 段落名和起止时间，段落之间不重叠 |
| chords | 起止时间和和弦标签，区间不重叠 |
| lyrics | 文本、起止时间和粒度 `line` 或 `word`。同一首只用一种粒度 |
| notes | 起止时间和 MIDI 音高。休止不写成音符 |
| bassPitches | 起止时间和音级。音级与产品一致：0 是 C，依次到 11 是 B |

`syntheticExample` 只给仓库里的公式样例使用。设为真的曲目一律不计分。真实授权精标省略它，或明确设为假。

精标和弦必须能按下面的规则规范化。音级时间不能重叠。任一事件若超出清单里的音频时长 0.05 秒以上，整份精标无效，该曲不计模型分。精标文件不接受 `confidence`。精标不是工程 JSON；把它放进曲库目录不会写回用户的谱。

听感和技术时间另两份文件，不属于音乐事实：

- `listening.json`：分离成功之后，由一位听评人给 bass、drums、vocals、other 各记一栏。
- `human-edit.json`：精标子集上的人工校正起止时间和时长。时长与起止时钟相差不能超过 1 秒，否则这条记录无效，不另选一个数字顶上。

## 预测文件

`prediction.json` 由以后在本机跑完模型的那一步写下。当前这个入口不负责生成它。

分离状态只取 `completed`、`failed` 或 `missing`。`completed` 必须同时有贝斯、鼓、人声和其他四条分轨，并写下 Demucs 的实现名 `demucs`、模型名和版本。产品默认对照值是 HTDemucs、CPU：`demucs --name htdemucs --device cpu`。实际参数以预测文件里的 `parameters` 为准，用了别的设备也照实记录，不因为和默认值不同就改分数。

`usedMixdownAsBass` 必须为假。文件里若为真，整份预测无效，贝斯音名、音符和歌词都不计算。分离失败或未运行时要写明原因，并且不能声明已经有分轨；预测里即便带了音名、音符或歌词，也忽略，不改用整曲混音补。

和弦、速度和段落可以来自各自记录的模型来源，不把它们当成贝斯分轨。来源实现名若是 `manual`、`gold`、`reference`、`human` 或 `label`，对应指标不计，避免把精标抄进预测后得到一份满分。歌唱识别只接受实现名 `faster-whisper`，并且要有模型名和版本。产品默认对照值是 CPU 上的 `tiny`。没有这份来源时，歌词文本和时间都不计算。

预测事件上的 `confidence` 可以被文件带上，计算时丢掉。报告不回写置信度，也不把它当成准确率。

模型当时的机器记在 `modelRun`：时间、CPU、内存字节数、GPU（没有就空）、操作系统和 Python。评分进程自己的环境另外记在 `scoringEnvironment`，包括它此刻能否 `find_spec` 到 Demucs 和 faster-whisper 以及发行版版本号。探测只读包元数据，不导入后加载权重。评分机器上没有安装这些包，只在警告里说明；只要预测文件自己带了来源，仍可计算对应指标。两个环境都要能看出来，不能把“包已安装”写成“准确率已经测过”。

墙钟时间用秒，字段为 `separationSeconds`、`structureSeconds`、`harmonySeconds`、`bassAnalysisSeconds`、`lyricRecognitionSeconds`。没记的阶段保持空，不用 0 代替。

## 指标

曲库级数值是进入分母的曲目的算术平均。精标类指标的分母是具备该层精标的曲目；听感和处理时间的分母是每首需要记录的曲目。状态为 `not_applicable` 的曲目不进平均。只要还有曲目是 `missing`、`not_evaluated`、`undefined` 或 `incomplete`，曲库级 `value` 就留空，不先发一个部分平均。

状态词：

| 状态 | 含义 |
| --- | --- |
| measured | 按公式得到了一个数 |
| missing | 该有的精标、预测、来源、听感表或墙钟没有到 |
| not_applicable | 前提已经明确不成立，例如分离失败，于是该项不做 |
| not_evaluated | 评估没有做，或输入无效所以拒绝计算 |
| undefined | 输入在，但公式除零或没有可配对对象。空集不是 1 分 |
| incomplete | 曲库里还有曲目没测完，所以不给总平均 |

### 分离听感

四条分轨各三个 1 到 5 的整数：`bleed`（串音）、`artifacts`（伪影）、`missingSource`（目标声部缺失）。5 表示串音更少、伪影更少、目标声部更完整。曲目分数是这 12 个数的平均。分离没有完成时，听感表即使填了也不计，状态为 `not_applicable`。这是人的听评，种类是 `human_listening`，不是模型置信度，也不是分离算法的内部损失。

### BPM 与小节偏差

主值是下拍的平均绝对误差，单位秒。金标和预测都按各自的下标对齐，只对齐两边都有的前缀；对不齐的小节记入 `missedGoldBars`、`extraPredictedBars` 和 `barCountError`，不把网格拉长或压缩后再算。同时给出中位数和第一拍偏移误差。

BPM 另记原始绝对误差 `|预测 − 精标|` 和相对误差。半速、倍速只作为 `nearestOctaveRelation`（`raw`、`half` 或 `double`）和对应的最近误差一并写下。半速把最近误差变成 0 时，原始绝对误差仍然保留，不用最近误差替换主报告里的 BPM 误差。速度和段落都要有 `structureProvenance`。

### 段落边界误差

取精标每个段落的开始和结束，对每个边界找预测边界里最近的一个，再取绝对误差的平均和中位数。大误差留在平均里，不剔除。预测段落若互相重叠，状态为 `not_evaluated`，不给误差。两边有一边没有边界时，误差无定义。

语义名称只在预测名全部属于固定集合时才算一致率：前奏、主歌、预副歌、副歌、桥段、间奏、尾奏，以及 Intro、Verse、Pre-Chorus、Chorus、Bridge、Interlude、Outro。按开始时间贪心匹配交并比至少 0.5 的段落，再要求名称完全相同。预测名是“候选段落 1”这类粗名时，名称一致率为空，原因是 `prediction_section_names_are_not_semantic`，不把这种情况记成 0 分。名称没有比较不影响边界误差本身。

### 和弦准确率

主值是精标和弦时长里，规范化标签完全一致的比例。没有被精标覆盖的时间不进分母，预测多出来的时长记在 `predictedSecondsOutsideGold`，不把它算成正确。预测标签无法规范化时，该重叠时长算不正确，并计入 `unparsedPredictionOverlaps`。预测没有任何和弦、而精标有和弦时，准确率是 0，这是测到了“没有命中”。预测字段本身缺失则是 `missing`，不是 0。

规范化：去掉空白；`♯` 视为 `#`，`♭` 视为 `b`；根音按音级比较，所以 `Bb` 与 `A#` 相同；输出拼写用升号。质量只接受大三（空或 maj）、小三（m、min）、属七（7）、大七（maj7、M7）、小七（m7、min7）、减、增、sus2、sus4（单独的 sus 视为 sus4）。`C?` 不能规范化，不能算作 C。`N.C.` 只与 `N.C.` 相同。斜杠低音参与“完全一致”，不参与根音一致。根音一致率写在 `rootAccuracy`。预测和弦重叠则不计算。

和弦使用 `harmonyProvenance`。分离失败时，只要和弦预测和来源都在，仍然可以算和弦；这不表示用混音代替了贝斯音名。

### 歌词时间偏差

只对规范化文本完全相同的一对计算。规范化是 NFKC、大小写折叠，再去掉空白以及 Unicode 类别属于标点或符号的字符。同一金标句若有多条文本相同的预测，取开始时间更近的那条，一条预测只用一次。主值是这些配对的开始时间平均绝对误差，同时给出结束时间平均绝对误差和未配上的句数。

文本不同就不配时间，所以不会把认错的句子配成一个很小的时间误差。一对都配不上时，时间误差无定义，不是 0 秒。粒度一个是句、一个是字词时，时间不计算，原因 `granularity_mismatch`。预测歌词重叠时也不计算时间。

### 歌唱识别

这项是字错误率：双方都按开始时间排序，拼成规范化字符串，编辑距离除以精标字符数。数值低表示文本更接近精标。细节里另有按上面配对规则得到的整句召回 `exactLineRecall`。空的识别结果相对非空精标，字错误率是 1。精标规范化后没有字符，则无定义。粒度不一致时仍然可以算字错误率，因为这项不使用时间轴；时间项保持未评估。

没有人声分轨、分离未完成，或来源不是带版本号的 faster-whisper 时，字错误率和时间误差都不计算。

### 音符 F1

音符按开始时间处理。一对算命中要同时满足：MIDI 音高相同，开始时间相差不超过 0.05 秒。每条预测最多配一条精标，贪心时先取更近的起音。精确率是命中除以命中加误报，召回是命中除以命中加漏报，F1 是二者的调和平均。容差写进结果，当前固定为起音 0.05 秒、结束 0.05 秒、音高 0 个半音。结束时间只在已命中的音符上另记 `offsetMatchRate`，不改变 F1。

没有预测时精确率无定义，F1 为空，即使召回是 0。精标和预测都是空时，F1 也是空，不用空集得到 1。音符和贝斯音名都要求分离已完成且贝斯分轨存在，并各有自己的模型来源。否则状态是 `not_applicable` 或 `missing`，数值为空。

### 贝斯音级

主值是精标贝斯音名时长里，音级相同的比例。音级编号与上面的精标相同。预测区间重叠则不计算。分离未完成或没有贝斯分轨时不计算，也不读取混音。预测列表存在但为空、精标非空时，一致率是 0。

### 人工校正时间

主值是该曲记录的 `durationSeconds`。曲库级主值是这些时长的中位数，并同时给出总和。这是成本，不是识别分数。未声明精标的曲目该项为 `not_applicable`。精标曲目缺记录则为 `missing`，不用工程修订次数或文件修改时间代替。

### 处理耗时

主值是范围内墙钟之和。预测文件存在时，分离时间始终在范围内。精标含有速度或段落时加上结构时间，含有和弦时加上和声时间。只有分离已经完成时，才把贝斯分析和歌词识别时间算进范围；分离失败就不把没跑的阶段按缺失处理，也不把它们记成 0。曲库级主值是各曲总和的平均，并给出这些总和的合计。

## 缺什么就写什么

| 情况 | 报告 |
| --- | --- |
| 没有 `--corpus`，目录不存在，或路径在仓库内 | 状态 `not_evaluated`，指标为空，退出码 3。仓库内路径不读取 |
| 清单或授权对不上、授权过期 | 不计分，状态 `not_evaluated` |
| 音频不存在或大小为 0 | 该曲指标 `missing`，原因 `audio_missing` 或 `audio_empty` |
| 声明了精标但没有 gold.json | `gold_missing` |
| 未声明精标却放了 gold.json | 警告 `gold_file_ignored`，该文件不计分 |
| 精标无效或和弦不能规范化 | `gold_invalid`，不给模型分 |
| 没有 prediction.json | 模型指标 `missing`，原因 `prediction_absent` |
| 分离失败 | 听感、贝斯音级、音符和歌唱识别为 `not_applicable`，原因 `separation_failed`，并保留失败说明。`separationOutcomes.failed` 计数 |
| 分离未运行 | 同上，原因 `separation_not_run` |
| 把混音当作贝斯 | `mixdown_rejected`，该曲不计分，`mixdownSubstitutedForBass` 仍为假 |
| 公式没有定义 | `undefined`，`value` 为空 |
| 合成样例 | `synthetic_example`，全部指标为空 |

曲目级能测的项目照实写成 `measured`。只要 P0 的曲目数、语种、精标数量或某一项指标还没齐，总状态就是 `incomplete`，退出码 4。`benchmarkComplete` 只在总状态为 `evaluated` 时为真，并且即便那时 `qualityPassed` 仍是空。

## 运行元数据

每份报告都带评分进程的操作系统、Python、CPU 型号和逻辑核数、内存字节数。GPU 不探测，字段为空，避免为了记账去占用显卡或下载运行库。模型若已在别的机器上跑完，那次的硬件、系统和 Python 记在预测文件的 `modelRun`；已完成分离却没有这段记录时，总状态不能成为 `evaluated`。

产品默认参数（HTDemucs / CPU，faster-whisper / tiny / CPU）写在 `productDefaults`，旁边注明这不是本次已执行的测量。实际使用的模型名、版本和参数来自预测文件，抄到每曲的 `models`。

## 人工修改

产品在重新分析时保留已锁定或人工来源的音名、和弦、歌词和网格，见工程保存逻辑。评估不参与这条路径：它只比较仓库外的精标和预测，不打开工程，不合并候选，不改 `project.json`。精标表达的是授权曲目上的对照，不是把用户已经改过的谱再分析一遍。

## 本次变更没有测量结果

本协议提交时没有附带授权音频、模型权重或用户工程，也没有运行 Demucs 或 faster-whisper。`backend/tests/evaluation_fixtures/` 是标成 `syntheticExample` 的公式样例；指向该目录会被仓库路径规则拒绝。公式单测里的小数只用于核对算术，不能当作分离质量、和弦准确率、歌唱识别准确率或备曲效率。

真实的 30 首基准要等授权曲库、权重和精标都在本机准备好之后，由上面的入口另跑。跑完之前，不发布准确率或效率数字。
