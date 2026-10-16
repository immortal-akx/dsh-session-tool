# -*- coding: utf-8 -*-
from PIL import Image, ImageDraw, ImageFont
import os, math
OUT = r"C:\Users\19113\.dsh\local-plugins\dsh-session-tool\docs"
F  = r"C:\Windows\Fonts\msyh.ttc"; FB = r"C:\Windows\Fonts\msyhbd.ttc"
def f(sz, bold=False): return ImageFont.truetype(FB if bold else F, sz)
BG=(250,251,253); INK=(28,32,38); DIM=(105,114,127); LINE=(203,211,221)
BLUE=(232,240,254); BLUE_L=(37,99,235); GREEN=(231,248,238); GREEN_L=(5,150,105)
ORANGE=(255,244,229); ORANGE_L=(200,110,0); RED=(254,235,235); RED_L=(214,38,38); GREY=(243,245,248); WHITE=(255,255,255)
def rr(d, box, r=12, fill=None, outline=None, w=2): d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=w)
def txt(d, xy, s, sz=18, bold=False, color=INK, anchor="la"): d.text(xy, s, font=f(sz, bold), fill=color, anchor=anchor)
def arrow(d, p1, p2, color=RED_L, w=3):
    d.line([p1, p2], fill=color, width=w)
    a = math.atan2(p2[1]-p1[1], p2[0]-p1[0]); Ln, Wd = 11, 6
    d.polygon([p2, (p2[0]-Ln*math.cos(a)+Wd*math.sin(a), p2[1]-Ln*math.sin(a)-Wd*math.cos(a)),
               (p2[0]-Ln*math.cos(a)-Wd*math.sin(a), p2[1]-Ln*math.sin(a)+Wd*math.cos(a))], fill=color)
def badge(d, x, y, n, color=RED_L, r=13):
    d.ellipse((x, y, x+2*r, y+2*r), fill=color)
    txt(d, (x+r, y+r), n, 16, True, WHITE, "mm")
def trash(d, x, y, s=15, color=RED_L):
    d.rounded_rectangle((x+s*0.2, y+s*0.32, x+s*0.8, y+s*0.94), radius=s*0.1, outline=color, width=2)
    d.line((x+s*0.1, y+s*0.32, x+s*0.9, y+s*0.32), fill=color, width=2)
    d.line((x+s*0.38, y+s*0.16, x+s*0.62, y+s*0.16), fill=color, width=2)
def pencil(d, x, y, s=15, color=BLUE_L):
    d.polygon([(x+s*0.1, y+s*0.9), (x+s*0.25, y+s*0.55), (x+s*0.75, y+s*0.05), (x+s*0.95, y+s*0.25), (x+s*0.45, y+s*0.75)], outline=color)
    d.line((x+s*0.25, y+s*0.55, x+s*0.45, y+s*0.75), fill=color, width=1)
def dots(d, x, y, s=15, color=DIM):
    for i in range(3): d.ellipse((x+i*6, y+2, x+i*6+3.5, y+5.5), fill=color)
def gear(d, x, y, s=15, color=DIM):
    d.ellipse((x, y, x+s, y+s), outline=color, width=2); d.ellipse((x+s*0.36, y+s*0.36, x+s*0.64, y+s*0.64), fill=color)

W, H = 960, 1060
img = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(img)
txt(d, (50, 34), "dsh-session-tool  v0.12.6", 36, True)
txt(d, (50, 84), "会话删除 + 重命名：三处界面入口与确认弹窗", 20, False, DIM)

# ---------------- 左侧：应用界面示意 ----------------
rr(d, (50, 140, 900, 1000), 16, WHITE, LINE)
txt(d, (74, 158), "界面示意", 22, True, BLUE_L)

# ① 对话区头部
txt(d, (74, 200), "① 对话区头部（工具栏）", 18, True, INK)
rr(d, (74, 228, 876, 292), 12, GREY, LINE)
txt(d, (92, 252), "「我的会话」", 19, False, INK)
rr(d, (200, 240, 236, 276), 6, BLUE, BLUE_L); pencil(d, 206, 245, 15)
for i, (label, wdt) in enumerate([("预设", 66), ("⚙", 44)]):
    x = 700 + i * 80
    rr(d, (x, 244, x + wdt, 278), 6, WHITE, LINE)
    gear(d, x + 14, 252, 15) if label == "⚙" else txt(d, (x + 10, 261), label, 15, False, INK, "lm")
dots(d, 828, 254, 14)
txt(d, (248, 246), "← 重命名按钮（我们加的）", 14, False, BLUE_L)

# ② 侧栏 ⋯ 菜单
txt(d, (74, 322), "② 侧栏会话行「…」菜单", 18, True, INK)
rr(d, (74, 350, 470, 560), 12, GREY, LINE)
txt(d, (92, 364), "左侧栏", 14, False, DIM)
for i, name in enumerate(["对话 A", "对话 B", "对话 C"]):
    ry = 392 + i * 54; sel = i == 1
    rr(d, (92, ry, 452, ry + 44), 8, (238,242,255) if sel else WHITE, LINE)
    txt(d, (106, ry + 22), name, 16, sel, anchor="lm")
    if sel: dots(d, 424, ry + 14, 14)
arrow(d, (476, 420), (508, 420), DIM, 2)
rr(d, (508, 350, 876, 560), 12, WHITE, LINE)
for i, item in enumerate(["置顶会话", "重命名", "分叉会话", "归档会话"]):
    iy = 372 + i * 34
    txt(d, (526, iy + 11), item, 16, False, INK, "lm")
rr(d, (516, 512, 868, 548), 6, RED, None)
trash(d, 530, 519, 16)
txt(d, (556, 530), "删除会话", 16, True, RED_L, "lm")
badge(d, 884, 512, "②")

# ③ 悬停区
txt(d, (74, 590), "③ 会话行悬停区", 18, True, INK)
rr(d, (74, 618, 876, 676), 12, GREY, LINE)
txt(d, (96, 647), "对话 B", 17, False, INK, "lm")
rr(d, (700, 630, 736, 664), 6, WHITE, LINE); dots(d, 708, 640, 14)
txt(d, (752, 647), "只剩 …", 15, True, GREEN_L, "lm")
txt(d, (74, 690), "官方「归档」「置顶」两个悬停按钮已被隐藏（配置项 ButtonItems.official.*.hidden）", 14, False, DIM)
badge(d, 884, 618, "③")

# ④⑤ 弹窗
txt(d, (74, 736), "④⑤ 确认弹窗（四态中的两种）", 18, True, INK)
def dialog(x, y, w, title, desc, ack, btn, running=False):
    rr(d, (x, y, x + w, y + 190), 12, WHITE, LINE, 2)
    txt(d, (x + 18, y + 14), title, 18, True)
    txt(d, (x + 18, y + 42), desc, 13, False, DIM)
    txt(d, (x + 18, y + 70), "会话：我的会话", 13, False, DIM)
    txt(d, (x + 18, y + 92), "序列号：session-9cc49402-…", 13, False, DIM)
    if running:
        d.polygon([(x + 20, y + 118), (x + 32, y + 138), (x + 8, y + 138)], outline=ORANGE_L, width=2)
        txt(d, (x + 42, y + 120), "会话正在运行 —— 删除会立即中断它正在进行的任务", 13, True, ORANGE_L)
    yy = y + 146 if running else y + 122
    rr(d, (x + 19, yy + 2, x + 31, yy + 14), 3, WHITE, DIM)
    txt(d, (x + 40, yy), ack, 14, False, INK)
    byy = y + 190 - 44
    d.line([(x + 1, byy - 10), (x + w - 1, byy - 10)], fill=LINE, width=1)
    rr(d, (x + w - 196, byy, x + w - 120, byy + 30), 8, WHITE, DIM); txt(d, (x + w - 158, byy + 15), "取消", 14, anchor="mm")
    rr(d, (x + w - 110, byy, x + w - 16, byy + 30), 8, WHITE, RED_L); txt(d, (x + w - 63, byy + 15), btn, 14, True, RED_L, "mm")
dialog(74, 768, 380, "删除会话", "删除后，该对话将不可恢复", "我已了解后果，确认删除", "删除")
badge(d, 60, 768, "④")
dialog(478, 768, 398, "删除会话", "删除后，该对话将不可恢复", "停止它并删除", "停止并删除", running=True)
badge(d, 464, 768, "⑤")

img.save(os.path.join(OUT, "preview.png"), "PNG")
print("OK", os.path.join(OUT, "preview.png"))