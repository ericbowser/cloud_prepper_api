-- SEQUENCE: prepper.aws_question_id_seq

-- DROP SEQUENCE IF EXISTS prepper.aws_question_id_seq;

CREATE SEQUENCE IF NOT EXISTS prepper.aws_question_id_seq
    INCREMENT 1
    START 194
    MINVALUE 1
    MAXVALUE 9223372036854775807
    CACHE 1;

ALTER SEQUENCE prepper.aws_question_id_seq
    OWNER TO ericbo;

CREATE SEQUENCE IF NOT EXISTS prepper.aws_question_number_seq
    INCREMENT 1
    START 94
    MINVALUE 1
    MAXVALUE 9223372036854775807
    CACHE 1;

ALTER SEQUENCE prepper.aws_question_number_seq
    OWNER TO ericbo;