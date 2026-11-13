"""The trained bundle must load and predict, not silently fall back to NEWS2."""

from types import SimpleNamespace

from backend.app.services import xgb_risk


def _patient(heart_rate, spo2, temperature, respiratory_rate, systolic_bp):
    reading = SimpleNamespace(
        heart_rate=heart_rate,
        spo2=spo2,
        temperature=temperature,
        respiratory_rate=respiratory_rate,
        systolic_bp=systolic_bp,
    )
    return SimpleNamespace(
        readings=[reading] * 9,
        profile=SimpleNamespace(age_years=68, sex="female", spo2_scale=1),
    )


def test_bundle_loads():
    assert xgb_risk._get_bundle() is not None


def test_comparison_flags_urgent_deterioration():
    result = xgb_risk.compare_with_xgboost(
        patient_state=_patient(134, 89, 39.2, 27, 92),
        vitals={
            "heart_rate": 134,
            "spo2": 89,
            "temperature": 39.2,
            "respiratory_rate": 27,
            "systolic_bp": 92,
            "activity_intensity": 0.0,
        },
        rule_tier="NORMAL",
        news2_total=0,
    )

    assert result["available"] is True
    assert result["with_xgboost"]["tier"] == "URGENT"
    assert result["with_xgboost"]["confidence"] > 0.5
    assert result["agreement"] == "DIVERGENT"


def test_comparison_flags_normal_resting_vitals():
    result = xgb_risk.compare_with_xgboost(
        patient_state=_patient(68, 98, 36.7, 14, 122),
        vitals={
            "heart_rate": 68,
            "spo2": 98,
            "temperature": 36.7,
            "respiratory_rate": 14,
            "systolic_bp": 122,
            "activity_intensity": 0.0,
        },
        rule_tier="NORMAL",
        news2_total=0,
    )

    assert result["with_xgboost"]["tier"] == "NORMAL"
    assert result["agreement"] == "ALIGNED"
