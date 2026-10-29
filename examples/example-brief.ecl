(
    < 404684003 |Clinical finding| :
    [1..*] {
        363698007 |Finding site| =
            << 123037004 |Body structure|,

        [0..1] 116676008 |Associated morphology| !=
            < 49755003 |Morphologically abnormal structure|
    }
    AND
    (
        246112005 |Severity| =
            << 24484000 |Severe|
        OR
        246112005 |Severity| =
            << 255604002 |Mild|
    )
)
MINUS
<< 64572001 |Disease|
