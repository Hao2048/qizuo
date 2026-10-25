请让已加入的角色实际协作，完成一部30秒、高质量、原创的炫酷视听短片《NEON / SINGULARITY｜霓虹奇点》。这是制作任务，不是只写计划。主题为深空中的霓虹能量核心：从暗场苏醒，到三维轨道/粒子环绕，再到能量过载、最后收束成光。风格克制、电影感、科技感，不做普通PPT字幕片，不以静态方框加淡入字幕代替特效。

交付1920×1080、30fps、精确30秒/900帧、H.264/yuv420p MP4，含原创合成的48kHz双声道电子配乐（最终AAC），画音同步。四段固定为 awakening [0,6)、orbit [6,14)、overdrive [14,23)、resolve [23,30]。核心具有连续运动、透视/遮挡与纵深，包含能量球/立体环、可见粒子轨迹、受控bloom与镜头推进；中段能量与速度升级，结尾留完整可读的标题。用黑蓝底、冰青/洋红/少量金色点缀，有清楚视觉主次。字幕少而精，英文主标题与一行中文副标题，所有字在8%安全边距内，不挡核心，不持续大字覆盖画面。不要下载、调用图像/视频付费API或使用受版权保护的音乐，全部程序化原创。

角色职责与顺序：
1. 创意导演：只写brief/（brief.json与简短README）。brief.json含title、subtitle、theme、duration:30,width:1920,height:1080,fps:30,bpm:120及acts四段{id,start,end,intent}。明确整体节奏、观众情绪和质量标准。由导演首次只建立一份共同约定neon-delivery；其他角色直接沿用contracts:[]，不改写同义约定，不建本地contracts文件。
2. 动效设计师：显式依赖导演，只写design/visual.json与简短说明；按brief创作数值化视觉方案。固定字段duration,width,height,fps,seed,palette:{background,cyan,magenta,gold}（均#RRGGBB）、title,subtitle,scenes四段。每段含id,start,end,label,energy（0..1）、cameraDistance:[起,终]（正数）、orbitSpeed、particleSpeed、ringCount（整数）。可增加必要数值字段，并说明轨道、配色、层次和转场设计。保持固定分段时间，不改变brief标题文本。不要创建渲染程序。
3. 声音设计师：显式依赖导演与设计师，只写audio/目录。读取brief和visual.json；交付score.json、render_audio.py、soundtrack.wav与简短README。score.json固定duration:30,sampleRate:48000,channels:2,bpm:120,markers:[0,6,14,23]，其余和声/音色自行设计。Python用项目内numpy合成有层次的原创电子节奏、低音、铺底、过门和收束，随四段情绪变化、有立体声，不只是单一正弦嗡声。不要外部下载。PCM16双声道WAV精确30秒，归一化避免削波，开头及末尾短淡入淡出。用workbench_command申请且仅申请python3 -s audio/render_audio.py生成真实WAV，不反复打印全部代码。
4. 合成工程师：显式依赖前三位，只写render/与delivery/两个目录，不能改上游。读取brief/brief.json、design/visual.json、audio/score.json和soundtrack.wav。自行编写frames.py与compose.mjs，实现实际连续动效并合成最终delivery/neon-core-30s.mp4、manifest.json与README。程序从JSON获取场景、配色、标题、时间与运动参数，不硬编码一套不响应设计师参数的画面。不能把预览图循环成30秒，也不能输出黑片。manifest包含duration,width,height,fps,frameCount:900、sceneIds、以及三个上游JSON和WAV的SHA256。数据不一致/子进程或ffmpeg失败必须非零退出，不能将旧产物称为新成功。
5. 网站开发工程师与本次任务无关，完全不规划、不执行、不推荐新增角色。

已有工具（只读，不属于任何角色修改范围）：tools/ffmpeg为本地独立可执行程序；tools/pythonlib/已提供兼容/usr/bin/python3的numpy与Pillow。Python脚本开始先sys.dont_write_bytecode=True，并把ROOT/tools/pythonlib插到sys.path首位再导入numpy/PIL；禁用用户site（python3 -s），不要访问用户Python库路径。只能用Python/Node内置库及这些已备工具。中文字体可用/System/Library/Fonts/STHeiti Medium.ttc，英文可用/System/Library/Fonts/Helvetica.ttc，避免不存在的Supplemental字体。

建议可靠的本地渲染方式：Pillow在960×540或更高内部分辨率绘制真正随时间变化的透视3D轨道/粒子，单独柔光层做高斯模糊再加法混合，输出时高质量缩放为1920×1080；预计算星点、三维曲线，控制粒子数量以让900帧在90秒左右完成，避免逐像素Python循环和每帧写PNG。以RGB24字节流pipe给tools/ffmpeg编码，合入audio/soundtrack.wav，libx264 preset veryfast、crf20、maxrate4M/bufsize8M，AAC192k，faststart；模型必须自行实现，不依赖外部浏览器或Blender。若能用更简洁可靠的方法达到相同效果可自行选择，但仍需有真正连续的几何运动与纵深。

合成工程师先提供node render/compose.mjs --preview，生成delivery/preview-03.png、preview-10.png、preview-18.png、preview-26.png四张对应秒数的PNG供我审查；批准预览后再申请node render/compose.mjs进行完整900帧渲染。每条命令都要审批，不允许安装依赖、网络、任意node -e自检或shell串联。不要覆盖TMPDIR，沙箱已给可写临时目录。所有大临时帧/中间文件放沙箱TMPDIR，交付目录只留4张预览、最终视频与小JSON/README，使整个项目保持100MB以内。权限按目录audio/、render/、delivery/分配，不要仅把某一个输出文件当作整个目录，否则无法创建必要临时交付文件。代码以清楚可维护为准，不强迫塞进很少行数，也不要无意义扩写注释。

只有声音设计师和合成工程师已授权本地命令，逐条审批仍保留；所有角色禁止联网、没有插件权限。成果均在角色副本，待我正常审阅应用和独立验收后才算完成。上游做好就直接给下游，不反复读/改已经正确的内容。遇到错误根据日志做最小修复；不要扩大权限、改变规格或偷偷换成简单PPT。先规划清晰、建立对接约定，然后立即按依赖执行。
