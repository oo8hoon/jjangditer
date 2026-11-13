# 짱디터 아이콘 생성기
#   python tools/make-icon.py
# build/icon.ico (멀티 사이즈), build/icon.png(256), build/icon-preview.png 를 만든다.
#
# 작은 크기(16~32)에서는 글씨가 뭉개지므로 심볼만, 큰 크기에서는 "JJang" 워드마크와
# 연필(Edit)까지 넣는 식으로 사이즈별로 다른 그림을 ICO 안에 담는다.
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build")

BLUE_TOP = (91, 168, 255, 255)
BLUE_BOT = (26, 88, 160, 255)
WHITE = (255, 255, 255, 255)
PENCIL = (255, 196, 84, 255)


def font(size, bold=True):
    for name in (("segoeuib.ttf", "arialbd.ttf") if bold else ("segoeui.ttf", "arial.ttf")):
        p = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", name)
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def vgrad(size, top, bot):
    """세로 그라데이션"""
    g = Image.new("RGBA", (1, size), top)
    px = g.load()
    for y in range(size):
        t = y / max(1, size - 1)
        px[0, y] = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(4))
    return g.resize((size, size), Image.BILINEAR)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def check(d, x, y, w, thick, color=WHITE):
    """체크 표시 (x,y = 왼쪽 위, w = 가로폭)"""
    d.line([(x, y + w * 0.45), (x + w * 0.36, y + w * 0.80), (x + w, y)],
           fill=color, width=max(1, int(thick)), joint="curve")


def draw_icon(S, with_text):
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    bg = vgrad(S, BLUE_TOP, BLUE_BOT)
    bg.putalpha(rounded_mask(S, int(S * 0.22)))
    img.alpha_composite(bg)
    d = ImageDraw.Draw(img)

    # 테두리 하이라이트
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22),
                        outline=(255, 255, 255, 70), width=max(1, int(S / 64)))

    # 좌측 도킹 띠 (화면 우측에 붙는 패널을 상징)
    d.rounded_rectangle([int(S * 0.075), int(S * 0.17), int(S * 0.145), int(S * 0.83)],
                        radius=int(S * 0.035), fill=(255, 255, 255, 165))

    if not with_text:
        # 작은 사이즈: 큰 체크 하나만
        check(d, S * 0.26, S * 0.30, S * 0.52, S * 0.115)
        return img

    left = S * 0.23
    right = S * 0.90
    thick = max(1, int(S * 0.045))

    # 체크리스트 2줄 (완료된 항목)
    for i, y in enumerate((0.17, 0.355)):
        cy = S * y
        box = S * 0.135
        d.rounded_rectangle([left, cy, left + box, cy + box],
                            radius=int(S * 0.028), outline=(255, 255, 255, 230),
                            width=max(1, int(S * 0.028)))
        check(d, left + box * 0.2, cy + box * 0.22, box * 0.62, S * 0.034)
        d.rounded_rectangle([left + box * 1.45, cy + box * 0.3,
                             right - (S * 0.1 if i else 0), cy + box * 0.68],
                            radius=int(S * 0.02), fill=(255, 255, 255, 190))

    # 세 번째 줄 = 편집 중 (연필)
    cy = S * 0.54
    box = S * 0.135
    d.rounded_rectangle([left, cy, left + box, cy + box],
                        radius=int(S * 0.028), outline=(255, 255, 255, 150),
                        width=max(1, int(S * 0.028)))
    d.rounded_rectangle([left + box * 1.45, cy + box * 0.3, right - S * 0.17, cy + box * 0.68],
                        radius=int(S * 0.02), fill=(255, 255, 255, 120))
    # 연필
    px0, py0 = right - S * 0.17, cy + box * 0.86
    pl = S * 0.20
    d.line([(px0, py0), (px0 + pl * 0.78, py0 - pl * 0.78)], fill=PENCIL, width=max(2, int(S * 0.055)))
    d.polygon([(px0 - S * 0.012, py0 + S * 0.012),
               (px0 + S * 0.055, py0 - S * 0.006),
               (px0 + S * 0.006, py0 - S * 0.055)], fill=WHITE)

    # JJang 워드마크
    fs = int(S * 0.215)
    f = font(fs)
    text = "JJang"
    bb = d.textbbox((0, 0), text, font=f)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    tx = left + (right - left - tw) / 2 - bb[0]
    ty = S * 0.735 - bb[1]
    d.text((tx + S * 0.012, ty + S * 0.012), text, font=f, fill=(0, 0, 0, 70))   # 그림자
    d.text((tx, ty), text, font=f, fill=WHITE)
    return img


def make(size):
    S = size * 4
    return draw_icon(S, with_text=(size >= 48)).resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    sizes = [16, 24, 32, 48, 64, 128, 256]
    imgs = {s: make(s) for s in sizes}
    imgs[256].save(os.path.join(OUT, "icon.ico"), format="ICO",
                   sizes=[(s, s) for s in sizes],
                   append_images=[imgs[s] for s in sizes if s != 256])
    imgs[256].save(os.path.join(OUT, "icon.png"))

    # 미리보기 (실제 보이는 크기대로 나열)
    pad = 16
    prev = Image.new("RGBA", (sum(sizes) + pad * (len(sizes) + 1), 256 + pad * 2), (32, 34, 42, 255))
    x = pad
    for s in sizes:
        prev.alpha_composite(imgs[s], (x, pad + (256 - s)))
        x += s + pad
    prev.save(os.path.join(OUT, "icon-preview.png"))
    print("생성:", ", ".join(str(s) for s in sizes))


if __name__ == "__main__":
    main()
