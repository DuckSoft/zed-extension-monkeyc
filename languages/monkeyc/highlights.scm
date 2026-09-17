(identifier) @variable
(comment) @comment
(string) @string
(character) @string
(escape_sequence) @string.escape
(number) @number
(boolean) @boolean
(null) @constant.builtin
(self) @variable.special
(global) @variable.special
(symbol) @string.special.symbol
(symbol name: (identifier) @string.special.symbol)

(type_identifier) @type
(type_identifier (identifier) @type)
(qualified_name (identifier) @type)
(null_type) @type.builtin
(void_type) @type.builtin
(class_declaration name: (identifier) @type)
(class_declaration superclass: (_) @type)
(typedef_declaration name: (identifier) @type)
(enum_declaration name: (identifier) @type)
(enum_member name: (identifier) @constant)
(module_declaration name: (identifier) @type)
(using_declaration path: (_) @type alias: (identifier)? @type)
(import_declaration path: (_) @type)
(variable_declaration kind: "const" (variable_declarator name: (identifier) @constant))

(member_expression property: (identifier) @property)
(function_declaration name: (identifier) @function)
(function_signature name: (identifier) @function)
(call_expression function: (identifier) @function)
(call_expression function: (member_expression property: (identifier) @function))
(parameter name: (identifier) @variable.parameter)
(annotation name: (identifier) @attribute)

["module" "class" "extends" "enum" "typedef" "interface" "alias" "var" "const"] @keyword
["public" "private" "protected" "hidden" "static" "native"] @keyword
["using" "import"] @keyword
"function" @keyword
["return" "break" "continue"] @keyword
["if" "else" "switch" "case" "default"] @keyword
["for" "while" "do"] @keyword
["try" "catch" "finally" "throw"] @keyword
["new" "as" "instanceof" "has" "and" "or"] @keyword
(method_type "Method" @type.builtin)

(right_shift_operator) @operator
["+" "-" "*" "/" "%" "&" "|" "^" "!" "~" "<<"
 "==" "!=" "<" "<=" ">" ">=" "&&" "||" "=" "+=" "-=" "*=" "/=" "%="
 "&=" "|=" "^=" "<<=" ">>=" "++" "--" "=>" "?"] @operator
["(" ")" "[" "]" "]b" "{" "}"] @punctuation.bracket
[";" "," "." ":"] @punctuation.delimiter
