def add(a, b):
    return a + b


def total(values):
    result = 0
    for value in values:
        result = add(result, value)
    return result
