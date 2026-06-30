"""Tests sin red para la parte delicada del shim n8n.

Corre con:  python3 test_n8n_client.py   (o: uv run python test_n8n_client.py)
No requiere n8n ni red — solo verifica interpolación, coerción y parsing.
"""
from datetime import date

from n8n_client import interpolate, _coerce, _row_to_tuple, _extract_rows


def check(name, got, expected):
    status = "ok  " if got == expected else "FAIL"
    print(f"  [{status}] {name}")
    if got != expected:
        print(f"        got:      {got!r}")
        print(f"        expected: {expected!r}")
    return got == expected


def main():
    ok = True
    print("interpolate:")
    # %s replacement with the canonical (since, until) params
    sql = ("SELECT * FROM bitrix.hs_deals "
           "WHERE fechacreacion >= %s AND fechacreacion <= %s "
           "AND LOWER(utm_campaign) LIKE '%%landing%%'")
    out = interpolate(sql, ("2026-03-27", "2026-05-26"))
    ok &= check(
        "params + LIKE escape",
        out,
        "SELECT * FROM bitrix.hs_deals "
        "WHERE fechacreacion >= '2026-03-27' AND fechacreacion <= '2026-05-26' "
        "AND LOWER(utm_campaign) LIKE '%landing%'",
    )
    # no params, only %% escapes
    ok &= check(
        "only %% escape",
        interpolate("WHERE x LIKE '%%foo%%'", None),
        "WHERE x LIKE '%foo%'",
    )
    # single-quote injection in a param is escaped
    ok &= check(
        "quote escaping",
        interpolate("WHERE name = %s", ("O'Brien",)),
        "WHERE name = 'O''Brien'",
    )
    # placeholder/param mismatch raises
    try:
        interpolate("WHERE a = %s AND b = %s", ("only-one",))
        ok &= check("mismatch raises", False, True)
    except ValueError:
        ok &= check("mismatch raises", True, True)

    print("_coerce (date reconstruction):")
    ok &= check("iso date → date", _coerce("2026-05-26"), date(2026, 5, 26))
    ok &= check("iso datetime → date", _coerce("2026-05-26T10:30:00"), date(2026, 5, 26))
    ok &= check("canal stays str", _coerce("Facebook"), "Facebook")
    ok &= check("category stays str", _coerce("alto"), "alto")
    ok &= check("int stays int", _coerce(42), 42)
    ok &= check("campaign name stays str", _coerce("IN-LANDING-FROM-ABR-2026"), "IN-LANDING-FROM-ABR-2026")

    print("_row_to_tuple (column order + date coercion):")
    # Q1 shape: (fecha::date, cat, leads) — order must be preserved
    row = {"fecha": "2026-05-26", "cat": "alto", "leads": 12}
    ok &= check("dict→tuple ordered", _row_to_tuple(row), (date(2026, 5, 26), "alto", 12))
    # Q3 shape consumed by index r[0]..r[7]
    row3 = {"campaign": "IN-LANDING", "adset": "—", "canal": "Facebook",
            "leads": 5, "aprobados": 3, "alto": 1, "medio": 1, "empuje": 1}
    t = _row_to_tuple(row3)
    ok &= check("index access r[0]", t[0], "IN-LANDING")
    ok &= check("index access r[7]", t[7], 1)

    print("_extract_rows (n8n response shapes):")
    ok &= check("direct list", _extract_rows([{"a": 1}]), [{"a": 1}])
    ok &= check("wrapped rows", _extract_rows({"rows": [{"a": 1}]}), [{"a": 1}])
    ok &= check("wrapped data", _extract_rows({"data": [{"a": 1}]}), [{"a": 1}])
    ok &= check("item envelope", _extract_rows([{"json": {"a": 1}}]), [{"a": 1}])
    ok &= check("empty", _extract_rows([]), [])

    print()
    print("ALL PASS" if ok else "SOME TESTS FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
