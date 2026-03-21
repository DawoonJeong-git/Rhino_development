# API Setup Guide

이 문서는 현재 프로젝트에서 나중에 연결할 외부 소스별로
어디에 접속해야 하는지, 어떤 값을 가져와야 하는지,
그리고 어떤 설정 키에 넣어야 하는지를 정리합니다.

## 입력 파일

직접 값을 넣을 파일:

- `C:\Users\HDL\Documents\Rhino_develop\config.local.json`

현재 파일에는 눈에 띄는 자리표시자가 들어 있습니다.

예:

- `__PUT_VWORLD_API_KEY_HERE__`
- `__PUT_JUSO_CONFIRM_KEY_HERE__`

이 값들을 실제 값으로 바꾸면 됩니다.

## 1. VWorld

- 공식 사이트: [브이월드 메인](https://www.vworld.kr/)
- 참고 데이터 페이지:
  - [국토교통부_지오코더 API](https://www.data.go.kr/data/15101106/openapi.do)
  - [국토교통부_연속지적도형정보](https://www.data.go.kr/data/15123899/openapi.do)
  - [국토교통부_GIS건물통합정보](https://www.data.go.kr/data/15123970/openapi.do)

가져와야 하는 값:

- `VWORLD_API_KEY`
- `VWORLD_API_DOMAIN`

설명:

- `VWORLD_API_KEY`: 브이월드 인증키
- `VWORLD_API_DOMAIN`: 브이월드에 등록한 사용 도메인

입력 위치:

- `config.local.json`의 `VWORLD_API_KEY`
- `config.local.json`의 `VWORLD_API_DOMAIN`

예시:

- 로컬 테스트: `http://localhost:3000`
- 웹 배포 후: `https://your-domain.example.com`

현재 프로젝트에서 이 값으로 열리는 기능:

- 주소 검색
- 역지오코딩
- 실제 대지 경계
- 추후 건물 footprint / 속성

## 2. Juso

- 공식 사이트: [주소기반산업지원서비스](https://business.juso.go.kr/addrlink/main.do)

가져와야 하는 값:

- `JUSO_CONFIRM_KEY`

설명:

- 주소검색 API 승인키입니다.
- 검색 API와 팝업 API는 승인키 종류가 다를 수 있으므로, 검색 API용 키인지 확인해야 합니다.

입력 위치:

- `config.local.json`의 `JUSO_CONFIRM_KEY`

현재 프로젝트에서 이 값으로 열리는 기능:

- 도로명주소 / 지번주소 검색 품질 강화
- 한국 주소 자동완성 개선

## 3. 건축HUB

- 공식 사이트: [국토교통부_건축HUB_건축물대장정보 서비스](https://www.data.go.kr/data/15134735/openapi.do)

가져와야 하는 값:

- `BUILDING_HUB_SERVICE_KEY`

설명:

- 공공데이터포털에서 활용신청 후 받는 서비스키입니다.

입력 위치:

- `config.local.json`의 `BUILDING_HUB_SERVICE_KEY`

현재 프로젝트에서 이 값으로 열리는 기능:

- 앱 내부 건축물대장 요약 조회
- 건축물대장 관련 속성 카드 표시

## 4. 국가법령정보 공동활용

- 공식 사이트: [국가법령정보 공동활용 메인](https://open.law.go.kr/LSO/main.do)
- 서비스 안내: [이용안내](https://open.law.go.kr/information/service.do)
- OC 관리 페이지: [API 인증값 변경](https://open.law.go.kr/LSO/usr/usrOcInfoMod.do)

가져와야 하는 값:

- `LAW_API_OC`

설명:

- 공동활용용 API 인증값(OC)입니다.

입력 위치:

- `config.local.json`의 `LAW_API_OC`

현재 프로젝트에서 이 값으로 열리는 기능:

- 법령/자치법규 검색 연계
- 위치 기반 법규 카드 자동화

## 5. DEM 파일

- 현재 공식 경로:
  - [국토정보플랫폼 메인](https://map.ngii.go.kr/mn/mainPage.do)
  - [국토정보맵](https://map.ngii.go.kr/ms/map/NlipMap.do)

가져와야 하는 값:

- `TERRAIN_DEM_PATH`

설명:

- API 키가 아니라 로컬에 내려받은 DEM 파일 경로입니다.
- 이 값은 지금 단계에서는 선택사항입니다.
- 예전에 안내된 일부 공공데이터포털 링크는 폐기되었거나 현재 직접 사용 경로로 적합하지 않을 수 있습니다.
- 현재는 국토정보플랫폼의 `공개DEM` 다운로드 또는 `수치지형도(DXF)` / `연속수치지형도(SHP)`를 통해 지형 데이터를 확보하는 방식이 더 현실적입니다.

입력 위치:

- `config.local.json`의 `TERRAIN_DEM_PATH`

현재 프로젝트에서 이 값으로 열리는 기능:

- synthetic contour를 실제 지형 데이터로 교체
- 실제 지형 메쉬 / 등고 생성

지금 당장 해야 하는 일:

- 없음
- 나머지 API 연결을 먼저 진행하고, DEM은 실제 지형 단계에서 다시 받으면 됩니다.

## 내가 나중에 받아야 하는 값 요약

당신이 저에게 "이제 연결해"라고 할 때 필요한 값:

- 브이월드:
  - `VWORLD_API_KEY`
  - `VWORLD_API_DOMAIN`
- Juso:
  - `JUSO_CONFIRM_KEY`
- 건축HUB:
  - `BUILDING_HUB_SERVICE_KEY`
- 국가법령정보:
  - `LAW_API_OC`
- DEM:
  - `TERRAIN_DEM_PATH`

가장 안전한 방식:

- 비밀값은 직접 `config.local.json`에 입력
- 입력 후 저에게 "브이월드 입력 완료", "건축HUB 입력 완료"처럼 알려주기
- 그러면 제가 그다음 연결 코드를 이어서 구현
