# h-mirror

사람 인식 + 인상착의 텍스트박스. 카메라로 사람을 인식하고 각 사람 옆에 색상 기반 인상착의를 표시.

people-tracker에서 effects/interactions 제거 + 인상착의 텍스트박스 추가한 버전.

## 기술
- React 19 + Vite + TypeScript + Bun
- MediaPipe Tasks Vision (Object Detector + Image Segmenter)
- 인상착의 추정: 사람 박스 중앙(상반신) 영역에서 RGB 평균 추출 → HSL 변환 → 색 이름 매핑
- GitHub Actions로 GitHub Pages에 자동 배포

## URL
- Production: https://h-mirror.wooo.uk
- Repo: https://github.com/chikacho90/h-mirror

## 운영
- Dev: `bun dev` → http://localhost:5173
- Build: `bun run build`
