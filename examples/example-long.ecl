(
    descendantOf 404684003 |Clinical finding| :
    [1 to many] {
        363698007 |Finding site| =
            descendantOrSelfOf 123037004 |Body structure|,

        [0 to 1] 116676008 |Associated morphology| not =
            descendantOf 49755003 |Morphologically abnormal structure|
    }
    AND
    (
        246112005 |Severity| =
            descendantOrSelfOf 24484000 |Severe|
        OR
        246112005 |Severity| =
            descendantOrSelfOf 255604002 |Mild|
    )
)
MINUS
descendantOrSelfOf 64572001 |Disease|
