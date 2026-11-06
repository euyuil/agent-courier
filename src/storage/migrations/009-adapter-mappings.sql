CREATE TABLE adapter_mappings (
  namespace TEXT NOT NULL, mappingKey TEXT NOT NULL, contentRef TEXT NOT NULL REFERENCES private_content(id),
  PRIMARY KEY(namespace,mappingKey)
) STRICT;
