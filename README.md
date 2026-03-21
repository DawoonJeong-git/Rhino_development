# 대지 컨텍스트 생성기

한국 건축계획용 대지 컨텍스트 도구의 초기 MVP입니다.

현재 구현 범위:

- 지도 기반 프론트
- 주소 검색 및 부분 검색 추천
- 지도 클릭 위치 선택
- 최근 선택 이력 저장
- 토지정보 / 법규 / 건축물대장용 공식 사이트 액션
- 대지 경계 + 등고 미리보기
- 3D 스펙 JSON 다운로드
- OBJ 프로토타입 다운로드

## 로컬 실행

1. `config.local.json.example`를 복사해 `config.local.json`을 만듭니다.
2. 아직 API 키가 없으면 그대로 둬도 됩니다.
3. 아래 명령으로 실행합니다.

```bash
npm run dev
```

브라우저에서 터미널에 출력된 `http://localhost:3000` 또는 다음 포트를 열면 됩니다.
포트 3000이 이미 사용 중이면 서버가 자동으로 다음 포트로 이동합니다.

## 설정 파일

`config.local.json`

```json
{
  "PORT": 3000,
  "VWORLD_API_KEY": "",
  "VWORLD_API_DOMAIN": "http://localhost:3000",
  "JUSO_CONFIRM_KEY": "",
  "BUILDING_HUB_SERVICE_KEY": "",
  "LAW_API_OC": "",
  "TERRAIN_DEM_PATH": "",
  "USE_NOMINATIM_FALLBACK": true
}
```

설정 설명:

- `VWORLD_API_KEY`: 브이월드 검색 / 지적도 / 건물 데이터 키
- `VWORLD_API_DOMAIN`: 브이월드에 등록한 사용 도메인
- `JUSO_CONFIRM_KEY`: 도로명주소 검색 품질 강화용 승인키
- `BUILDING_HUB_SERVICE_KEY`: 건축HUB 건축물대장 조회용 서비스키
- `LAW_API_OC`: 국가법령정보 공동활용용 OC 값
- `TERRAIN_DEM_PATH`: 추후 DEM 파일 기반 지형 생성용 로컬 파일 경로
- `USE_NOMINATIM_FALLBACK`: 브이월드 키가 없을 때 임시 검색 fallback 사용 여부

API별 준비물과 공식 링크는 [api-setup-guide.md](C:/Users/HDL/Documents/Rhino_develop/docs/api-setup-guide.md)에 정리되어 있습니다.

참고:

- `TERRAIN_DEM_PATH`는 선택사항입니다.
- DEM 관련 일부 예전 링크는 폐기되었을 수 있어, 현재는 국토정보플랫폼의 `공개DEM` 또는 `수치지형도 / 연속수치지형도` 다운로드 경로를 사용하는 쪽으로 정리했습니다.

## 현재 동작

- 주소 검색은 브이월드 키가 없으면 임시 fallback 검색으로 동작
- 대지 경계는 브이월드 키가 없으면 모의 대지 경계로 동작
- 등고는 아직 synthetic preview
- OBJ는 실제 설계 파일이 아니라 프로토타입 지형/대지 확인용

## 다음 단계

1. 브이월드 실대지 연결
2. DEM 기반 실제 지형 연결
3. 건물 footprint / 높이 연결
4. 3DM / DXF / OBJ 실제 export 정교화
